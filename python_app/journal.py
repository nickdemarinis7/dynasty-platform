from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any

from .analytics import TeamContext, TradeResult
from .models import DraftPick, League, Player, Roster
from .value_system import pick_profile

MODEL_VERSION = "trade-engine-2026.11.09.2"


@dataclass(frozen=True)
class CalibrationSlice:
    label: str
    tracked: int
    resolved: int
    positive: int
    positive_rate: float | None


@dataclass(frozen=True)
class CalibrationReport:
    tracked: int
    resolved: int
    positive_rate: float | None
    observed: int
    mean_absolute_error: float | None
    directional_accuracy: float | None
    useful_feedback_rate: float | None
    by_confidence: tuple[CalibrationSlice, ...]
    readiness: str


def build_calibration_report(decisions: list[dict[str, Any]]) -> CalibrationReport:
    """Summarize journal outcomes without treating unrecorded values as zero."""
    resolved_statuses = {"accepted", "rejected", "completed", "succeeded", "failed"}
    positive_statuses = {"accepted", "completed", "succeeded"}
    resolved = [item for item in decisions if item.get("status") in resolved_statuses]
    positive = [item for item in resolved if item.get("status") in positive_statuses]
    observed: list[tuple[float, float]] = []
    for item in decisions:
        actual = (item.get("outcome") or {}).get("actual_lineup_change")
        predicted = (item.get("payload") or {}).get("prediction", {}).get("lineup_change")
        if isinstance(actual, (int, float)) and isinstance(predicted, (int, float)):
            observed.append((float(predicted), float(actual)))
    errors = [abs(actual - predicted) for predicted, actual in observed]
    directions = [
        (abs(actual) < .5 if abs(predicted) < .5 else (actual > 0) == (predicted > 0))
        for predicted, actual in observed
    ]
    feedback = [item.get("feedback") for item in decisions if item.get("feedback")]
    useful = sum(item == "Useful" for item in feedback)
    labels = sorted({str((item.get("payload") or {}).get("confidence") or "Unrated") for item in decisions})
    slices: list[CalibrationSlice] = []
    for label in labels:
        group = [item for item in decisions if str((item.get("payload") or {}).get("confidence") or "Unrated") == label]
        group_resolved = [item for item in group if item.get("status") in resolved_statuses]
        group_positive = sum(item.get("status") in positive_statuses for item in group_resolved)
        slices.append(CalibrationSlice(
            label, len(group), len(group_resolved), group_positive,
            group_positive / len(group_resolved) if group_resolved else None,
        ))
    readiness = "Calibrating" if len(resolved) < 10 or len(observed) < 5 else "Early signal" if len(resolved) < 30 or len(observed) < 15 else "Decision-ready sample"
    return CalibrationReport(
        tracked=len(decisions), resolved=len(resolved),
        positive_rate=len(positive) / len(resolved) if resolved else None,
        observed=len(observed), mean_absolute_error=sum(errors) / len(errors) if errors else None,
        directional_accuracy=sum(directions) / len(directions) if directions else None,
        useful_feedback_rate=useful / len(feedback) if feedback else None,
        by_confidence=tuple(slices), readiness=readiness,
    )


def _asset(player: Player) -> dict[str, Any]:
    return {"id": player.id, "name": player.name, "position": player.position, "team": player.team, "age": player.age, "value": player.value, "injury_status": player.injury_status}


def _pick(pick: DraftPick, league: League) -> dict[str, Any]:
    profile = pick_profile(pick, league)
    return {"year": pick.year, "round": pick.round, "label": pick.label, "original_owner": pick.original_owner, "provider_value": pick.value, "adjusted_value": profile.adjusted_value, "projection": profile.projection, "range": [profile.low, profile.high], "confidence": profile.confidence, "class_outlook": profile.class_outlook, "class_multiplier": profile.class_multiplier, "top_prospects": list(profile.top_prospects)}


def trade_snapshot(
    league: League, team: Roster, partner: Roster,
    send_players: tuple[Player, ...] | list[Player], receive_players: tuple[Player, ...] | list[Player],
    send_picks: tuple[DraftPick, ...] | list[DraftPick], receive_picks: tuple[DraftPick, ...] | list[DraftPick],
    result: TradeResult, context: TeamContext, *, source: str, confidence: str = "—",
    score: int | None = None, score_breakdown: tuple[tuple[str, float], ...] = (),
) -> dict[str, Any]:
    sends = [player.name for player in send_players] + [pick.label for pick in send_picks]
    receives = [player.name for player in receive_players] + [pick.label for pick in receive_picks]
    return {
        "id": str(uuid.uuid4()), "saved_at": int(time.time()), "league_id": league.id,
        "decision_type": "trade", "title": f"{team.team_name} ↔ {partner.team_name}",
        "status": "considering", "feedback": None, "outcome": {},
        "payload": {
            "model_version": MODEL_VERSION, "source": source, "league": league.name,
            "imported_at": league.imported_at, "week": league.current_week, "mode": league.mode,
            "team_context": {"record": team.record, "competitive_rank": context.league_rank, "asset_rank": context.asset_rank, "window": context.window, "playoff_probability": context.playoff_probability},
            "send_players": [_asset(player) for player in send_players], "send_picks": [_pick(pick, league) for pick in send_picks],
            "receive_players": [_asset(player) for player in receive_players], "receive_picks": [_pick(pick, league) for pick in receive_picks],
            "sends_label": ", ".join(sends) or "Nothing", "receives_label": ", ".join(receives) or "Nothing",
            "prediction": {"fairness": result.fairness, "lineup_change": result.lineup_a.points_gained, "playoff_change": result.lineup_a.playoff_points_gained, "depth_change": result.lineup_a.depth_change, "partner_fit": result.acceptance_score, "verdict": result.verdict},
            "confidence": confidence, "recommendation_score": score,
            "score_breakdown": [{"label": label, "contribution": value} for label, value in score_breakdown],
        },
    }


def waiver_snapshot(league: League, roster: Roster, idea: Any) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()), "saved_at": int(time.time()), "league_id": league.id,
        "decision_type": "waiver", "title": f"Add {idea.add.name}", "status": "considering",
        "feedback": None, "outcome": {},
        "payload": {
            "model_version": MODEL_VERSION, "source": "waiver_assistant", "league": league.name,
            "imported_at": league.imported_at, "week": league.current_week, "mode": league.mode,
            "add": _asset(idea.add), "drop": _asset(idea.drop) if idea.drop else None,
            "prediction": {"lineup_change": idea.lineup_gain, "playoff_change": idea.playoff_gain, "depth_change": idea.depth_change, "value_change": idea.value_gain},
            "category": idea.category, "confidence": idea.confidence, "score": idea.score,
            "suggested_faab": idea.suggested_faab, "faab_remaining": roster.waiver_budget_remaining,
        },
    }
