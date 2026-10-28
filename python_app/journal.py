from __future__ import annotations

import time
import uuid
from typing import Any

from .analytics import TeamContext, TradeResult
from .models import DraftPick, League, Player, Roster

MODEL_VERSION = "trade-engine-2026.10.27.1"


def _asset(player: Player) -> dict[str, Any]:
    return {"id": player.id, "name": player.name, "position": player.position, "team": player.team, "age": player.age, "value": player.value, "injury_status": player.injury_status}


def _pick(pick: DraftPick) -> dict[str, Any]:
    return {"year": pick.year, "round": pick.round, "label": pick.label, "original_owner": pick.original_owner, "value": pick.value}


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
            "send_players": [_asset(player) for player in send_players], "send_picks": [_pick(pick) for pick in send_picks],
            "receive_players": [_asset(player) for player in receive_players], "receive_picks": [_pick(pick) for pick in receive_picks],
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
