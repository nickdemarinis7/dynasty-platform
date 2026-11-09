from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
import math
from time import monotonic
from typing import Any, Literal

from .analytics import ProjectionProfile, TeamContext, TradeResult, active_roster_players, build_contexts, calc_fppg, compute_projection_profiles, compute_projections, evaluate_trade, optimize_lineup, package_value, projected_points
from .models import DraftPick, League, Player, Roster
from .value_system import pick_profile, premium_value_cutoff, protected_player_ids


@dataclass(frozen=True)
class Recommendation:
    kind: str
    partner: Roster
    send_players: tuple[Player, ...]
    send_picks: tuple[DraftPick, ...]
    receive_players: tuple[Player, ...]
    receive_picks: tuple[DraftPick, ...]
    evaluation: TradeResult
    score: int
    reason: str
    objective: str = "Starter upgrade"
    tier: str = "Exploratory"
    evidence: tuple[str, ...] = ()
    cautions: tuple[str, ...] = ()
    confidence: str = "D"
    confidence_reasons: tuple[str, ...] = ()
    score_breakdown: tuple[tuple[str, float], ...] = ()
    review_only: bool = False


@dataclass(frozen=True)
class RecommendationSearchPerformance:
    elapsed_ms: int
    packages_evaluated: int
    recommendations_returned: int
    viable_candidates: int = 0
    rejection_counts: tuple[tuple[str, int], ...] = ()
    team_diagnosis: str = ""


RiskProfile = Literal["Conservative", "Balanced", "Aggressive"]


def _team_diagnosis(context: TeamContext, league: League) -> str:
    if context.record_rank is not None and context.points_rank is not None:
        underlying_ranks = [context.league_rank, context.asset_rank, context.points_rank]
        underlying_rank = min(rank for rank in underlying_ranks if rank > 0)
        meaningful_rank_gap = 1 if league.team_count <= 4 else 2
        if (
            context.record_rank > math.ceil(league.team_count / 2)
            and context.record_rank - underlying_rank >= meaningful_rank_gap
            and context.window in {"Win Now", "Competing"}
        ):
            return "Underperforming contender"
    if context.contender_confidence == "Fragile contender":
        return "Fragile contender"
    if context.window in {"Win Now", "Competing"}:
        return "Contender"
    if context.window in {"Young Core", "Rebuilding"}:
        return "Rebuilder"
    return "Flexible middle"


def _buy_objective(send_players: tuple[Player, ...], receive_players: tuple[Player, ...], receive_picks: tuple[DraftPick, ...]) -> str:
    if receive_picks:
        return "Balanced package"
    if len(send_players) >= 2 and len(receive_players) == 1:
        return "Consolidation"
    if len(receive_players) >= 2:
        return "Starter plus depth"
    return "Starter upgrade"


def recommendation_search_notes(league: League, target_position: str | None = None) -> tuple[str, ...]:
    """Explain the most likely constraints behind a sparse or empty search."""
    notes: list[str] = []
    if league.values_status != "live":
        return ("Current market values are unavailable, so trade packages cannot be evaluated safely.",)
    if league.trade_deadline_week is not None and league.current_week > league.trade_deadline_week and any(roster.games_played for roster in league.rosters):
        return (f"The league's week {league.trade_deadline_week} trade deadline has passed.",)
    roster = next(item for item in league.rosters if item.team_id == league.my_team_id)
    context = build_contexts(league)[roster.team_id]
    if target_position and context.position_needs.get(target_position, 0) < 20:
        notes.append(f"{target_position} is not currently a major league-relative roster need.")
    if not league.weekly_points:
        notes.append("Current-week projections are missing, which lowers package confidence.")
    if context.window in {"Win Now", "Competing"} and not league.playoff_weekly_points:
        notes.append("Playoff projections are missing for a contending roster.")
    if context.resilience_score < 55 or context.critical_positions:
        positions = ", ".join(context.critical_positions) or "critical positions"
        notes.append(f"Thin {positions} depth causes packages that remove active contributors to fail safety gates.")
    if len(protected_player_ids(roster, league)) >= max(1, len(active_roster_players(roster)) // 2):
        notes.append("A large share of the roster is protected as core value, leaving fewer realistic outgoing assets.")
    notes.append("Remaining packages may have failed market-balance, partner-fit, or starting-lineup improvement gates.")
    return tuple(notes)


def diversify_recommendations(ideas: list[Recommendation], limit: int) -> list[Recommendation]:
    """Preserve score order while ensuring distinct objectives and partners surface."""
    selected: list[Recommendation] = []
    selected_ids: set[int] = set()
    seen_objectives: set[str] = set()
    partner_counts: dict[str, int] = {}
    outgoing_packages: set[tuple[tuple[str, ...], tuple[tuple[int, int, str], ...]]] = set()

    def outgoing_key(idea: Recommendation) -> tuple[tuple[str, ...], tuple[tuple[int, int, str], ...]]:
        return (
            tuple(sorted(player.id for player in idea.send_players)),
            tuple(sorted((pick.year, pick.round, pick.original_owner) for pick in idea.send_picks)),
        )

    def add(idea: Recommendation) -> bool:
        package = outgoing_key(idea)
        if id(idea) in selected_ids or package in outgoing_packages or partner_counts.get(idea.partner.team_id, 0) >= 2:
            return False
        selected.append(idea)
        selected_ids.add(id(idea))
        seen_objectives.add(idea.objective)
        outgoing_packages.add(package)
        partner_counts[idea.partner.team_id] = partner_counts.get(idea.partner.team_id, 0) + 1
        return True

    for idea in ideas:
        if idea.objective not in seen_objectives:
            add(idea)
        if len(selected) >= limit:
            return selected
    for idea in ideas:
        add(idea)
        if len(selected) >= limit:
            return selected
    # In very small leagues, relax the partner cap rather than returning fewer results.
    for idea in ideas:
        if id(idea) not in selected_ids and outgoing_key(idea) not in outgoing_packages:
            selected.append(idea)
            outgoing_packages.add(outgoing_key(idea))
        if len(selected) >= limit:
            break
    return selected


def _anchor_ids(roster: Roster, league: League) -> set[str]:
    return protected_player_ids(roster, league)


def _score(
    result: TradeResult,
    target_need: float,
    is_sell: bool = False,
    risk_profile: RiskProfile = "Balanced",
) -> tuple[int, tuple[tuple[str, float], ...]]:
    market = max(-25.0, min(25.0, result.fairness))
    lineup = max(-10.0, min(10.0, result.lineup_a.points_gained))
    fit = max(-20.0, min(20.0, result.fit_a))
    depth = max(-25.0, min(25.0, result.lineup_a.depth_change))
    playoff = max(-10.0, min(10.0, result.lineup_a.playoff_points_gained or 0))
    lineup_weight = {"Conservative": 1.7, "Balanced": 2.1, "Aggressive": 2.6}[risk_profile]
    playoff_weight = {"Conservative": 1.2, "Balanced": 1.6, "Aggressive": 2.0}[risk_profile]
    depth_weight = {"Conservative": 1.15, "Balanced": .75, "Aggressive": .40}[risk_profile]
    components = (
        ("Base", 50.0),
        ("Market fairness", market * .7),
        ("Current lineup", lineup * lineup_weight),
        ("Playoff lineup", playoff * playoff_weight),
        ("Timeline and need fit", fit * .35),
        ("Roster resilience", depth * depth_weight),
        ("Positional need", target_need * .12),
    )
    user_value = sum(value for _, value in components)
    if is_sell:
        components = (("Base", 50.0), ("Market fairness", market * .5), ("Timeline fit", fit * .4))
        user_value = sum(value for _, value in components)
    user_value = max(0, min(100, user_value))
    # Quality means a strong deal for both managers, not merely maximum value
    # extracted by the user's team. Penalize lopsided recommendations.
    raw = user_value * .55 + result.acceptance_score * .45
    raw -= abs(user_value - result.acceptance_score) * .12
    breakdown = components + (("Partner fit", (result.acceptance_score - 50) * .45), ("Two-sided balance", -abs(user_value - result.acceptance_score) * .12))
    return round(max(0, min(100, raw))), tuple((label, round(value, 1)) for label, value in breakdown)


def _depth_score(result: TradeResult, target_need: float) -> tuple[int, tuple[tuple[str, float], ...]]:
    """Score insurance moves primarily by the protection they buy the user."""
    components = (
        ("Base", 50.0),
        ("Resilience improvement", min(32.0, max(0.0, result.lineup_a.depth_change) * 2.0)),
        ("Playoff insurance", min(8.0, max(0.0, result.lineup_a.playoff_points_gained or 0) * 1.2)),
        ("Current lineup", min(4.0, max(0.0, result.lineup_a.points_gained))),
        ("Positional urgency", min(5.0, target_need * .05)),
        ("Market balance", max(-4.0, min(4.0, result.fairness * .3))),
        ("Partner viability", max(-3.0, min(5.0, (result.acceptance_score - 50) * .1))),
    )
    return round(max(0, min(100, sum(value for _, value in components)))), tuple((label, round(value, 1)) for label, value in components)


def _confidence(
    league: League,
    context: TeamContext,
    partner: Roster,
    assets: tuple[Player | DraftPick, ...],
    outlooks: dict[str, ProjectionProfile] | None = None,
) -> tuple[str, tuple[str, ...]]:
    score = 100
    reasons: list[str] = []
    if not league.weekly_points:
        score -= 22
        reasons.append("Current-week projections are unavailable")
    if context.window in {"Win Now", "Competing"} and not league.playoff_weekly_points:
        score -= 15
        reasons.append("Playoff-week projections are unavailable")
    trades = league.manager_tendencies.get(partner.team_id, {}).get("trades", 0)
    if trades < 2:
        score -= 10
        reasons.append("Partner history has fewer than two completed trades")
    if len(assets) >= 3:
        score -= 8
        reasons.append("Multi-asset packages carry more negotiation uncertainty")
    risky = [asset for asset in assets if isinstance(asset, Player) and (asset.injury_status or "").lower() in {"q", "questionable", "d", "doubtful"}]
    if risky:
        score -= 10
        reasons.append("At least one player has an uncertain injury designation")
    players = [asset for asset in assets if isinstance(asset, Player)]
    uncertain_picks = [
        asset for asset in assets
        if isinstance(asset, DraftPick) and pick_profile(asset, league).confidence == "Low"
    ]
    if uncertain_picks:
        score -= 8
        reasons.append("At least one distant pick has a wide projected-value range")
    thin_roles = [player for player in players if float(league.player_stats.get(player.id, {}).get("gp") or 0) < 3]
    if thin_roles:
        score -= 12
        reasons.append("At least one player has fewer than three games of season role evidence")
    weak_weekly_evidence = [player for player in players if player.id not in league.weekly_points]
    if weak_weekly_evidence:
        score -= 10
        reasons.append("At least one player lacks a current-week projection")
    low_outlooks = [player for player in players if outlooks and outlooks.get(player.id) and outlooks[player.id].confidence == "Low"]
    if low_outlooks and league.weekly_player_stats:
        score -= 8
        reasons.append("At least one player has a low-confidence scoring outlook")
    limited_sources = sum(source.level != "ready" for source in league.source_health)
    if limited_sources:
        deduction = min(15, limited_sources * 3)
        score -= deduction
        reasons.append(f"{limited_sources} supporting data sources are limited")
    grade = "A" if score >= 85 else "B" if score >= 70 else "C" if score >= 55 else "D"
    if not reasons:
        reasons.append("Market, projection, playoff, and partner-history evidence are all available")
    return grade, tuple(reasons)


def _reliable_depth_target(player: Player, league: League) -> bool:
    if player.team == "FA" or (player.injury_status or "").lower() in {"out", "o", "ir", "pup", "nfi", "suspended", "sus", "doubtful", "d"}:
        return False
    stats = league.player_stats.get(player.id, {})
    games = float(stats.get("gp") or 0)
    season_points = calc_fppg(stats, player, league) if games >= 3 else 0.0
    weekly = float(league.weekly_points.get(player.id) or 0)
    floor = 10.0 if player.position == "QB" else 5.0 if player.position == "TE" else 6.0
    return player.value >= 10 and (season_points >= floor or weekly >= floor + 1)


def _candidate_packages(
    target_value: float,
    expendable: list[Player],
    picks: tuple[DraftPick, ...],
    partner: Roster,
    league: League,
    contexts: dict[str, TeamContext],
) -> list[tuple[list[Player], list[DraftPick]]]:
    partner_context = contexts[partner.team_id]
    ranked = sorted(
        expendable,
        key=lambda player: (
            partner_context.position_needs.get(player.position, 0),
            -abs(player.value - target_value),
        ),
        reverse=True,
    )[:10]
    packages: list[tuple[list[Player], list[DraftPick]]] = []
    for offer in ranked:
        if .55 * target_value <= offer.value <= 1.35 * target_value:
            packages.append(([offer], []))
        if league.mode != "redraft":
            for pick in picks:
                combined = offer.value + pick_profile(pick, league).adjusted_value * .9
                if .65 * target_value <= combined <= 1.35 * target_value:
                    packages.append(([offer], [pick]))
    for first, second in combinations(ranked[:8], 2):
        combined = first.value + second.value * .9
        if .7 * target_value <= combined <= 1.3 * target_value:
            packages.append(([first, second], []))
    # Keep the search bounded and deterministic as return-package shapes grow.
    unique: dict[tuple[tuple[str, ...], tuple[tuple[int, int, str], ...]], tuple[list[Player], list[DraftPick]]] = {}
    for players, package_picks in packages:
        key = (
            tuple(sorted(player.id for player in players)),
            tuple(sorted((pick.year, pick.round, pick.original_owner) for pick in package_picks)),
        )
        unique[key] = (players, package_picks)
    return sorted(
        unique.values(),
        key=lambda package: abs(
            sum(player.value for player in package[0])
            + sum(pick_profile(pick, league).adjusted_value * .9 for pick in package[1])
            - target_value
        ),
    )[:6]


def _return_packages(target: Player, partner: Roster, league: League) -> list[tuple[tuple[Player, ...], tuple[DraftPick, ...], float]]:
    """Generate a small set of realistic returns anchored by the target player."""
    packages: list[tuple[tuple[Player, ...], tuple[DraftPick, ...], float]] = [((target,), (), target.value)]
    if league.mode != "redraft":
        sweeteners = sorted(
            (
                pick for pick in partner.draft_picks
                if pick.round >= 2 and 0 < pick_profile(pick, league).adjusted_value <= max(15, target.value * .60)
            ),
            key=lambda pick: pick_profile(pick, league).adjusted_value,
        )[:1]
        for pick in sweeteners:
            value = target.value + pick_profile(pick, league).adjusted_value * .9
            packages.append(((target,), (pick,), value))
    secondary = sorted(
        (
            player for player in active_roster_players(partner)
            if player.id != target.id and 5 <= player.value <= max(12, target.value * .50)
        ),
        key=lambda player: (abs(player.value - target.value * .25), -player.value),
    )[:1]
    for player in secondary:
        packages.append(((target, player), (), target.value + player.value * .9))
    return packages


def _pick_return_packages(player: Player, partner: Roster, league: League) -> list[tuple[DraftPick, ...]]:
    """Find bounded future-capital returns for a rebuilding sale."""
    priced = [pick for pick in partner.draft_picks if pick_profile(pick, league).adjusted_value > 0]
    candidates = [(pick,) for pick in priced]
    candidates.extend(combinations(priced, 2))
    viable = [
        tuple(package) for package in candidates
        if .65 * player.value <= package_value([], list(package), league) <= 1.35 * player.value
    ]
    return sorted(
        viable,
        key=lambda package: (
            abs(package_value([], list(package), league) - player.value),
            len(package),
            tuple((pick.year, pick.round, pick.original_owner) for pick in package),
        ),
    )[:8]


def _passes_quality_gates(
    result: TradeResult,
    send_players: list[Player],
    send_picks: list[DraftPick],
    target: Player,
    league: League,
    user_context: TeamContext,
    partner_context: TeamContext,
) -> bool:
    """Keep merely legal trades out of the actionable recommendation set."""
    if result.acceptance_score < 45 or result.lineup_a.points_gained < 1:
        return False
    if result.fairness > 15 or result.fairness < -12:
        return False
    if result.lineup_a.depth_change < -10 and result.lineup_a.points_gained < 5:
        return False
    if result.lineup_a.critical_positions and result.lineup_a.after_resilience < 50:
        return False
    if user_context.window in {"Win Now", "Competing"}:
        if result.lineup_a.after_resilience < 55 or result.lineup_a.depth_change < -8:
            return False

    if any(player.position == "QB" for player in send_players) and target.position != "QB":
        qb_warning = any(warning.startswith("QB:") for warning in result.lineup_a.coverage_warnings)
        if qb_warning or (target.value < premium_value_cutoff(league) and result.lineup_a.points_gained < 5):
            return False
    firsts = [pick for pick in send_picks if pick.round == 1]
    if firsts:
        # Firsts should buy durable, premium assets—not turn small weekly gains
        # from ordinary starters into recommendations.
        if target.value < max(premium_value_cutoff(league), max(pick_profile(pick, league).adjusted_value for pick in firsts) * 1.75):
            return False
        if result.fairness < -8:
            return False
        if result.lineup_a.points_gained < 3.5 and (result.lineup_a.playoff_points_gained or 0) < 5:
            return False

    elite_outgoing = max((player.value for player in send_players), default=0)
    if send_picks and elite_outgoing >= premium_value_cutoff(league) and target.value < elite_outgoing * 1.15:
        return False

    # A contender has little reason to trade away a starter for a package that
    # does not improve its lineup. Rebuilders may rationally prefer value/picks.
    if partner_context.window in {"Win Now", "Competing"} and send_players:
        if not result.lineup_b.received_player_starts or result.lineup_b.points_gained < -1:
            return False
    return True


def _passes_review_gates(
    result: TradeResult,
    user_context: TeamContext,
    send_players: list[Player] | tuple[Player, ...] = (),
    receive_players: list[Player] | tuple[Player, ...] = (),
    league: League | None = None,
) -> bool:
    """Allow useful conversation starters without presenting unsafe deals as recommendations."""
    if result.acceptance_score < 48 or not result.lineup_a.received_player_starts:
        return False
    if not (-18 <= result.fairness <= 20):
        return False
    if result.lineup_a.points_gained < 0:
        return False
    if result.lineup_a.depth_change < -15:
        return False
    if user_context.window in {"Win Now", "Competing"} and result.lineup_a.after_resilience < 40:
        return False
    outgoing_qbs = [player for player in send_players if player.position == "QB"]
    if league and league.mode != "redraft" and outgoing_qbs:
        incoming_qbs = [player for player in receive_players if player.position == "QB"]
        outgoing_value = max(player.value for player in outgoing_qbs)
        replacement_value = max((player.value for player in incoming_qbs), default=0)
        # A small current-week gain does not justify turning a premium dynasty
        # quarterback into a much weaker or nonexistent QB asset.
        if replacement_value < outgoing_value * .80 and result.lineup_a.points_gained < 6:
            return False
        youngest_outgoing = min((player.age for player in outgoing_qbs if player.age > 0), default=0)
        youngest_incoming = min((player.age for player in incoming_qbs if player.age > 0), default=99)
        if youngest_outgoing and youngest_incoming > youngest_outgoing + 3:
            return False
        if "QB" in result.lineup_a.critical_positions:
            return False
    return True


def _passes_qb_asset_safety(
    result: TradeResult,
    send_players: list[Player] | tuple[Player, ...],
    receive_players: list[Player] | tuple[Player, ...],
    league: League,
) -> bool:
    """Apply dynasty-QB safety to every surfaced path, not only review-only deals."""
    outgoing_qbs = [player for player in send_players if player.position == "QB"]
    if not outgoing_qbs:
        return True
    incoming_qbs = [player for player in receive_players if player.position == "QB"]
    if "QB" in result.lineup_a.critical_positions:
        return False
    if len(send_players) >= 2 and result.lineup_a.points_gained < 6:
        return False
    if league.mode == "redraft":
        return True
    if not incoming_qbs and result.lineup_a.points_gained < 8:
        return False
    outgoing_value = max(player.value for player in outgoing_qbs)
    incoming_value = max((player.value for player in incoming_qbs), default=0)
    if incoming_value < outgoing_value * .85 and result.lineup_a.points_gained < 6:
        return False
    outgoing_ages = [player.age for player in outgoing_qbs if player.age > 0]
    incoming_ages = [player.age for player in incoming_qbs if player.age > 0]
    if outgoing_ages and incoming_ages and min(incoming_ages) > min(outgoing_ages) + 3:
        return False
    return True


def _passes_final_review_value(result: TradeResult) -> bool:
    """Require a review-only idea to offer material upside after full modeling."""
    playoff_gain = result.lineup_a.playoff_points_gained or 0
    if result.lineup_a.points_gained < 1 and playoff_gain < 4:
        return False
    if result.lineup_a.depth_change < -10:
        return False
    if result.lineup_a.critical_positions and result.lineup_a.after_resilience < 55:
        return False
    return True


def _hard_gate_reason(
    result: TradeResult,
    send_players: list[Player] | tuple[Player, ...],
    receive_players: list[Player] | tuple[Player, ...],
    send_picks: list[DraftPick] | tuple[DraftPick, ...],
    league: League,
    target: Player | None = None,
) -> str | None:
    """Reject only unsafe or non-viable packages; rank ordinary tradeoffs later."""
    if not _passes_qb_asset_safety(result, send_players, receive_players, league):
        return "QB asset safety"
    if not result.lineup_a.received_player_starts and receive_players:
        return "No starting-lineup role"
    if result.acceptance_score < 30:
        return "Partner viability"
    if not (-25 <= result.fairness <= 25):
        return "Market imbalance"
    if result.lineup_a.points_gained < -1:
        return "Lineup decline"
    if result.lineup_a.depth_change < -25:
        return "Severe depth loss"
    if result.lineup_a.critical_positions and result.lineup_a.after_resilience < 35:
        return "Critical roster coverage"
    firsts = [pick for pick in send_picks if pick.round == 1]
    if firsts and target is not None:
        minimum_return = max(premium_value_cutoff(league), max(pick_profile(pick, league).adjusted_value for pick in firsts) * 1.5)
        if target.value < minimum_return:
            return "First-round pick protection"
    return None


def _recommendation_tier(
    result: TradeResult,
    score: int,
    risk_profile: RiskProfile,
) -> str | None:
    """Classify viable packages without turning ordinary costs into vetoes."""
    current = result.lineup_a.points_gained
    playoff = result.lineup_a.playoff_points_gained or 0
    depth = result.lineup_a.depth_change
    if score >= 72 and result.acceptance_score >= 48 and abs(result.fairness) <= 12 and current >= 1 and depth >= -10:
        return "Best fit"
    if risk_profile == "Aggressive" and score >= 56 and (current >= 2 or playoff >= 4) and depth >= -20:
        return "Aggressive upside"
    if score >= 62 and result.acceptance_score >= 42 and abs(result.fairness) <= 18 and current >= .5 and depth >= (-6 if risk_profile == "Conservative" else -14):
        return "Balanced option"
    if score >= 55 and result.acceptance_score >= 38 and (current >= .5 or playoff >= 2.5) and depth >= -18:
        return "Exploratory"
    return None


def _evidence(result: TradeResult, league: League, context: TeamContext, partner: Roster) -> tuple[tuple[str, ...], tuple[str, ...]]:
    playoff_note = f" · {context.playoff_probability}% playoff odds" if context.playoff_probability is not None else ""
    deadline_note = f" · {context.deadline_status}" if context.deadline_status != "No deadline" else ""
    tendency = league.manager_tendencies.get(partner.team_id, {})
    position_counts = {position: tendency.get(f"{position.lower()}_acquired", 0) for position in ("QB", "RB", "WR", "TE")}
    preferred = max(position_counts, key=position_counts.get) if max(position_counts.values(), default=0) > 0 else None
    history_note = f"Partner history: {int(tendency.get('trades', 0))} completed trades"
    if preferred:
        history_note += f" · most often acquired {preferred}"
    if tendency.get("picks_acquired", 0):
        history_note += f" · {int(tendency['picks_acquired'])} picks acquired"
    evidence = (
        f"Team context: {context.contender_confidence} · {context.window}{playoff_note}{deadline_note}",
        history_note,
        f"Market-value difference: {result.fairness:+.1f}% for your side",
        f"Projected starting-lineup change: {result.lineup_a.points_gained:+.1f} PPG",
        f"Projected playoff-lineup change: {result.lineup_a.playoff_points_gained:+.1f} PPG across weeks {', '.join(map(str, result.lineup_a.playoff_weeks_modeled))}" if result.lineup_a.playoff_points_gained is not None else "Playoff-week projections are not yet available",
        f"Roster resilience: {result.lineup_a.before_resilience} → {result.lineup_a.after_resilience} ({result.lineup_a.depth_change:+.0f})",
        f"Partner-fit heuristic: {result.acceptance_score}/100",
    )
    cautions: list[str] = []
    if not league.weekly_points:
        cautions.append("Weekly projections are unavailable; lineup impact uses scored season averages.")
    if result.acceptance_score < 50:
        cautions.append("The other roster receives a below-neutral fit; negotiation may require a different secondary asset.")
    if abs(result.fairness) > 12:
        cautions.append("The package is near the outer market-fairness limit.")
    if result.lineup_a.coverage_warnings:
        cautions.append("Post-trade coverage: " + "; ".join(result.lineup_a.coverage_warnings))
    return evidence, tuple(cautions)


def generate_recommendations(
    league: League,
    limit: int = 15,
    target_position: str | None = None,
    include_low_confidence: bool = False,
    include_review_candidates: bool = False,
    risk_profile: RiskProfile = "Balanced",
    _metrics: dict[str, Any] | None = None,
) -> list[Recommendation]:
    if _metrics is not None:
        _metrics["packages_evaluated"] = 0
        _metrics["viable_candidates"] = 0
        _metrics["rejections"] = {}

    def reject(reason: str) -> None:
        if _metrics is not None:
            rejections = _metrics["rejections"]
            rejections[reason] = rejections.get(reason, 0) + 1
    if league.values_status != "live" or (league.trade_deadline_week is not None and league.current_week > league.trade_deadline_week and any(roster.games_played for roster in league.rosters)):
        return []
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    contexts = build_contexts(league)
    my_context = contexts[my_team.team_id]
    diagnosis = _team_diagnosis(my_context, league)
    if _metrics is not None:
        _metrics["team_diagnosis"] = diagnosis
    projections = {projection.player.id: projection for projection in compute_projections(league)}
    outlooks = {profile.player.id: profile for profile in compute_projection_profiles(league)}
    anchors = _anchor_ids(my_team, league)
    ideas: list[Recommendation] = []

    needs = sorted(my_context.position_needs.items(), key=lambda item: item[1], reverse=True)
    expendable = [player for player in my_team.players if player.id not in anchors and player.value >= 10]
    for position, need in needs:
        minimum_need = 0 if diagnosis == "Underperforming contender" or risk_profile == "Aggressive" else 10 if risk_profile == "Balanced" else 20
        if need < minimum_need:
            continue
        for partner in league.rosters:
            if partner.team_id == my_team.team_id:
                continue
            targets = sorted(
                (player for player in partner.players if player.position == position and player.value >= 15),
                key=lambda player: (projected_points(player, league), player.value),
                reverse=True,
            )[:2]
            for target in targets:
                target_status = (target.injury_status or "active").lower()
                if my_context.window in {"Win Now", "Competing"} and target_status in {"out", "o", "ir", "pup", "nfi", "suspended", "sus", "doubtful", "d"}:
                    continue
                if league.mode != "redraft" and target.age > 31 and projections[target.id].trajectory == "DECLINING":
                    continue
                candidates: list[Recommendation] = []
                for receive_players, receive_picks, return_value in _return_packages(target, partner, league):
                    packages = _candidate_packages(return_value, expendable, my_team.draft_picks, partner, league, contexts)
                    for send_players, send_picks in packages:
                        result = evaluate_trade(
                            my_team, partner, send_players, list(receive_players), league,
                            send_picks, list(receive_picks), contexts, model_playoffs=False,
                        )
                        if _metrics is not None:
                            _metrics["packages_evaluated"] += 1
                        gate_reason = _hard_gate_reason(result, send_players, receive_players, send_picks, league, target)
                        if gate_reason:
                            reject(gate_reason)
                            continue
                        # Playoff-week optimization is substantially more expensive.
                        # Run it only after the package clears current-week, market,
                        # depth, and partner screens.
                        result = evaluate_trade(
                            my_team, partner, send_players, list(receive_players), league,
                            send_picks, list(receive_picks), contexts,
                        )
                        score, breakdown = _score(result, need, risk_profile=risk_profile)
                        tier = _recommendation_tier(result, score, risk_profile)
                        if tier is None:
                            reject("Insufficient strategic upside")
                            continue
                        if tier == "Exploratory" and not include_review_candidates:
                            reject("Exploratory hidden")
                            continue
                        incoming = ", ".join(sorted({player.position for player in send_players}))
                        reason = (
                            f"Addresses your {position} need while {partner.team_name} receives {incoming} value that fits its roster and timeline."
                            if need >= 20
                            else f"Raises your {position} lineup ceiling while {partner.team_name} receives {incoming} value that fits its roster and timeline."
                        )
                        evidence, cautions = _evidence(result, league, my_context, partner)
                        confidence_assets = tuple(send_players) + tuple(send_picks) + receive_players + receive_picks
                        confidence, confidence_reasons = _confidence(league, my_context, partner, confidence_assets, outlooks)
                        if confidence not in {"A", "B"} and not include_low_confidence:
                            reject("Evidence confidence")
                            continue
                        recommendation = Recommendation(
                            kind="BUY", partner=partner, send_players=tuple(send_players), send_picks=tuple(send_picks),
                            receive_players=receive_players, receive_picks=receive_picks, evaluation=result, score=score, reason=reason,
                            objective=_buy_objective(tuple(send_players), receive_players, receive_picks), tier=tier,
                            evidence=evidence, cautions=cautions, confidence=confidence,
                            confidence_reasons=confidence_reasons, score_breakdown=breakdown, review_only=tier == "Exploratory",
                        )
                        candidates.append(recommendation)
                        if _metrics is not None:
                            _metrics["viable_candidates"] += 1
                if candidates:
                    ideas.append(max(candidates, key=lambda idea: (idea.score, idea.evaluation.acceptance_score)))

    if league.mode != "redraft" and (my_context.resilience_score < 65 or my_context.critical_positions):
        depth_positions = set(my_context.critical_positions) or {position for position, need in needs if need >= 50}
        usable_picks = [pick for pick in my_team.draft_picks if pick.round >= 2 and pick.value > 0]
        for partner in league.rosters:
            if partner.team_id == my_team.team_id:
                continue
            partner_active = active_roster_players(partner)
            partner_starters = {player.id for player in optimize_lineup(partner_active, league).starters}
            targets = sorted(
                (
                    player for player in partner_active
                    if player.position in depth_positions and player.id not in partner_starters
                    and _reliable_depth_target(player, league)
                ),
                key=lambda player: (projected_points(player, league), player.value),
                reverse=True,
            )[:4]
            for target in targets:
                for pick in usable_picks:
                    adjusted_pick = pick_profile(pick, league).adjusted_value
                    if not (.65 * target.value <= adjusted_pick <= 1.35 * target.value):
                        continue
                    result = evaluate_trade(my_team, partner, [], [target], league, [pick], [], contexts, model_playoffs=False)
                    if _metrics is not None:
                        _metrics["packages_evaluated"] += 1
                    if result.acceptance_score < 45 or abs(result.fairness) > 12:
                        continue
                    if result.lineup_a.depth_change < 6 or result.lineup_a.after_resilience <= result.lineup_a.before_resilience:
                        continue
                    result = evaluate_trade(my_team, partner, [], [target], league, [pick], [], contexts)
                    score, breakdown = _depth_score(result, my_context.position_needs.get(target.position, 0))
                    tier = "Best fit" if score >= 75 else "Balanced option" if score >= 62 else "Exploratory"
                    if tier == "Exploratory" and not include_review_candidates:
                        reject("Exploratory hidden")
                        continue
                    confidence, confidence_reasons = _confidence(league, my_context, partner, (pick, target), outlooks)
                    if confidence not in {"A", "B"} and not include_low_confidence:
                        reject("Evidence confidence")
                        continue
                    evidence, cautions = _evidence(result, league, my_context, partner)
                    ideas.append(Recommendation(
                        kind="DEPTH", partner=partner, send_players=(), send_picks=(pick,),
                        receive_players=(target,), receive_picks=(), evaluation=result, score=score,
                        reason=f"Adds a playable {target.position} reserve and raises roster resilience from {result.lineup_a.before_resilience} to {result.lineup_a.after_resilience}.",
                        objective="Depth insurance", tier=tier,
                        evidence=evidence, cautions=cautions, confidence=confidence,
                        confidence_reasons=confidence_reasons, score_breakdown=breakdown,
                        review_only=tier == "Exploratory",
                    ))
                    if _metrics is not None:
                        _metrics["viable_candidates"] += 1
                    break

    if league.mode != "redraft":
        # A contender should use productive veterans and picks to improve its
        # title odds, not liquidate useful players for distant draft capital.
        allow_pick_sales = my_context.window not in {"Win Now", "Competing"}
        for player in expendable:
            if not allow_pick_sales:
                continue
            projection = projections[player.id]
            age_cliff = {"RB": 27, "WR": 29, "TE": 30, "QB": 34}.get(player.position, 99)
            if player.age < age_cliff or projection.trajectory != "DECLINING":
                continue
            for partner in league.rosters:
                if partner.team_id == my_team.team_id or contexts[partner.team_id].win_now_weight < .4:
                    continue
                partner_candidates: list[Recommendation] = []
                for pick_package in _pick_return_packages(player, partner, league):
                    result = evaluate_trade(my_team, partner, [player], [], league, [], list(pick_package), contexts, model_playoffs=False)
                    if _metrics is not None:
                        _metrics["packages_evaluated"] += 1
                    if abs(result.fairness) > 12 or result.acceptance_score < 45:
                        continue
                    result = evaluate_trade(my_team, partner, [player], [], league, [], list(pick_package), contexts)
                    capital = ", ".join(pick.label for pick in pick_package)
                    reason = f"Moves an aging {player.position} into {capital} while {partner.team_name} adds a win-now contributor."
                    evidence, cautions = _evidence(result, league, my_context, partner)
                    score, breakdown = _score(result, 0, True, risk_profile)
                    tier = "Best fit" if score >= 72 else "Balanced option" if score >= 62 else "Exploratory" if score >= 52 else None
                    if tier is None or (tier == "Exploratory" and not include_review_candidates):
                        reject("Insufficient strategic upside")
                        continue
                    confidence, confidence_reasons = _confidence(league, my_context, partner, (player, *pick_package), outlooks)
                    if score < (55 if include_low_confidence else 60):
                        continue
                    if confidence not in {"A", "B"} and not include_low_confidence:
                        continue
                    partner_candidates.append(Recommendation(
                        kind="SELL", partner=partner, send_players=(player,), send_picks=(), receive_players=(),
                        receive_picks=pick_package, evaluation=result, score=score, reason=reason, evidence=evidence,
                        objective="Future value", tier=tier,
                        cautions=cautions, confidence=confidence, confidence_reasons=confidence_reasons,
                        score_breakdown=breakdown, review_only=tier == "Exploratory",
                    ))
                    if _metrics is not None:
                        _metrics["viable_candidates"] += 1
                if partner_candidates:
                    ideas.append(max(partner_candidates, key=lambda idea: (idea.score, idea.evaluation.acceptance_score, -len(idea.receive_picks))))

    deduped: dict[tuple[str, tuple[str, ...], tuple[str, ...]], Recommendation] = {}
    for idea in ideas:
        received = tuple(sorted([player.id for player in idea.receive_players] + [pick.label for pick in idea.receive_picks]))
        sent = tuple(sorted([player.id for player in idea.send_players] + [pick.label for pick in idea.send_picks]))
        key = (idea.partner.team_id, sent, received)
        if key not in deduped or idea.score > deduped[key].score:
            deduped[key] = idea
    needs_depth = my_context.resilience_score < 65 or bool(my_context.critical_positions)
    ranked = sorted(
        deduped.values(),
        key=lambda idea: (1 if needs_depth and idea.kind == "DEPTH" else 0, idea.score, idea.evaluation.acceptance_score),
        reverse=True,
    )
    # Final invariant audit. This deliberately repeats the QB safety check so
    # no alternate candidate path or future refactor can surface an unsafe deal.
    ranked = [
        idea for idea in ranked
        if _passes_qb_asset_safety(idea.evaluation, idea.send_players, idea.receive_players, league)
    ]
    if target_position:
        ranked = [idea for idea in ranked if idea.receive_players and idea.receive_players[0].position == target_position]
    return diversify_recommendations(ranked, limit)


def timed_generate_recommendations(
    league: League,
    limit: int = 15,
    target_position: str | None = None,
    include_low_confidence: bool = False,
    include_review_candidates: bool = False,
    risk_profile: RiskProfile = "Balanced",
) -> tuple[list[Recommendation], RecommendationSearchPerformance]:
    metrics: dict[str, Any] = {}
    started = monotonic()
    ideas = generate_recommendations(
        league, limit, target_position, include_low_confidence, include_review_candidates, risk_profile, metrics,
    )
    performance = RecommendationSearchPerformance(
        round((monotonic() - started) * 1000), metrics.get("packages_evaluated", 0), len(ideas),
        metrics.get("viable_candidates", 0),
        tuple(sorted(metrics.get("rejections", {}).items(), key=lambda item: item[1], reverse=True)),
        metrics.get("team_diagnosis", ""),
    )
    return ideas, performance
