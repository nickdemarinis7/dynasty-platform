from __future__ import annotations

from dataclasses import dataclass, replace
from itertools import combinations
import math
from time import monotonic
from typing import Any, Literal

from .analytics import ProjectionProfile, TeamContext, TradeResult, active_roster_players, build_contexts, calc_fppg, compute_projection_profiles, compute_projections, evaluate_trade, optimize_lineup, package_value, projected_points, tradable_roster_players
from .models import DraftPick, League, Player, Roster
from .value_system import pick_profile, premium_value_cutoff, protected_player_ids, value_profile
from .observability import record_event


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
    team_value_score: int = 0
    market_value_score: int = 0
    score_low: int = 0
    score_high: int = 0
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
    full_evaluations: int = 0


@dataclass(frozen=True)
class MultiStepPath:
    intermediary: Player
    first: Recommendation
    second: Recommendation
    score: int
    final_lineup_delta: float
    final_playoff_delta: float | None
    stop_after_step_one_safe: bool
    execution_risk: str


RiskProfile = Literal["Conservative", "Balanced", "Aggressive"]


def _score_range(score: int, confidence: str, team_score: int, market_score: int) -> tuple[int, int]:
    evidence_width = {"A": 4, "B": 7, "C": 11, "D": 15}.get(confidence, 15)
    disagreement_width = min(6, round(abs(team_score - market_score) * .10))
    width = evidence_width + disagreement_width
    return max(0, score - width), min(100, score + width)


def _evidence_adjusted_score(score: int, confidence: str) -> tuple[int, float]:
    """Make the displayed overall score reflect evidence quality, not utility alone."""
    adjusted = (
        score if confidence == "A"
        else max(0, score - 4) if confidence == "B"
        else min(69, max(0, score - 12)) if confidence == "C"
        else min(54, max(0, score - 20))
    )
    return adjusted, float(adjusted - score)


def _usage_opportunities(player: Player, stats: dict[str, float]) -> float:
    if player.position == "QB":
        return float(stats.get("pass_att") or 0) + float(stats.get("rush_att") or 0) * .25
    if player.position == "RB":
        return float(stats.get("rush_att") or 0) + float(stats.get("rec_tgt") or stats.get("tgt") or 0)
    if player.position in {"WR", "TE"}:
        targets = float(stats.get("rec_tgt") or stats.get("tgt") or 0)
        snaps = float(stats.get("off_snp") or stats.get("snap") or 0)
        return targets + snaps * .04
    return 0.0


def _usage_role_risk(player: Player | None, league: League) -> tuple[float, str | None]:
    """Detect material opportunity loss before market values fully react."""
    if player is None or len(league.weekly_player_stats) < 3:
        return 0.0, None
    # Passing volume is game-script dependent and is not evidence that an
    # established QB lost the job. QB role security is modeled separately
    # from provider status, depth-chart order, and challenger evidence.
    if player.position == "QB":
        return 0.0, None
    weeks = sorted(league.weekly_player_stats)
    history = [
        _usage_opportunities(player, league.weekly_player_stats[week].get(player.id, {}))
        for week in weeks
    ]
    recent = sum(history[-2:]) / 2
    prior_window = history[-5:-2]
    prior = sum(prior_window) / len(prior_window) if prior_window else history[-3]
    if prior >= 5:
        ratio = recent / prior
        league_players = [asset for roster in league.rosters for asset in roster.players] + list(league.free_agents)
        competitors: list[tuple[float, Player]] = []
        for teammate in league_players:
            if teammate.id == player.id or teammate.team != player.team or teammate.position != player.position:
                continue
            teammate_recent = sum(
                _usage_opportunities(teammate, league.weekly_player_stats[week].get(teammate.id, {}))
                for week in weeks[-2:]
            ) / 2
            competitors.append((teammate_recent, teammate))
        takeover = max(competitors, default=(0.0, player), key=lambda item: item[0])
        if ratio < .45:
            detail = f" while {takeover[1].name} rose ahead" if takeover[0] > recent * 1.25 and takeover[0] >= 5 else ""
            return 18.0, f"Severe recent-role decline: {player.name}'s opportunities fell {round((1 - ratio) * 100)}%{detail}"
        if ratio < .70:
            detail = f" while {takeover[1].name} rose ahead" if takeover[0] > recent * 1.25 and takeover[0] >= 5 else ""
            return 9.0, f"Recent-role warning: {player.name}'s opportunities fell {round((1 - ratio) * 100)}%{detail}"
    return 0.0, None


def _signal_role_risk(player: Player | None, league: League) -> tuple[float, str | None]:
    """Translate structured availability and crowd activity into bounded risk."""
    if player is None:
        return 0.0, None
    signal = league.player_signals.get(player.id, {})
    status = str(signal.get("status") or "").strip().lower()
    practice = str(signal.get("practice_participation") or "").strip().lower()
    description = str(signal.get("practice_description") or signal.get("injury_notes") or "").strip()
    if status in {"inactive", "retired", "suspended", "reserve", "pup", "nfi", "ir"}:
        return 30.0, f"Severe availability signal: {player.name} is listed as {status.upper()}"
    injury_status = (player.injury_status or "").lower()
    if practice in {"did not participate", "dnp"}:
        suffix = f" ({description})" if description else ""
        penalty = 18.0 if injury_status in {"out", "o", "doubtful", "d"} else 11.0
        return penalty, f"Practice warning: {player.name} did not participate{suffix}"
    if practice in {"limited", "limited participation"} and injury_status:
        suffix = f" ({description})" if description else ""
        return 6.0, f"Practice caution: {player.name} was limited{suffix}"
    try:
        adds = int(signal.get("trending_adds_24h") or 0)
        drops = int(signal.get("trending_drops_24h") or 0)
        window = int(signal.get("trend_window_hours") or 0)
    except (TypeError, ValueError):
        adds, drops, window = 0, 0, 0
    if window != 24:
        return 0.0, None
    # Crowd movement is noisy: it can reduce confidence but cannot create the
    # severe veto reserved for status, depth-chart, or usage evidence.
    if drops >= 1000 and drops >= max(250, adds * 2):
        return 8.0, f"Market activity warning: Sleeper reports {drops:,} drops versus {adds:,} adds for {player.name} in its 24-hour window"
    if drops >= 300 and drops >= max(100, adds * 3):
        return 4.0, f"Market activity caution: {player.name} is trending toward drops on Sleeper"
    return 0.0, None


def _combined_role_risk(player: Player | None, league: League) -> tuple[float, tuple[str, ...]]:
    signals = (_qb_role_risk(player, league), _usage_role_risk(player, league), _signal_role_risk(player, league))
    return max((penalty for penalty, _ in signals), default=0.0), tuple(warning for _, warning in signals if warning)


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
    if context.contender_confidence == "Long shot":
        return "Playoff long shot" if league.mode == "redraft" else "Long-term reset"
    if context.contender_confidence == "In the hunt":
        return "Playoff hopeful" if league.mode == "redraft" else "Flexible contender"
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


def _strategic_summary(result: TradeResult, context: TeamContext) -> str:
    current = result.lineup_a.points_gained
    playoff = result.lineup_a.playoff_points_gained or 0
    title_delta = (result.championship_probability_after or 0) - (result.championship_probability_before or 0)
    remaining = result.lineup_a.remaining_season_points_gained
    if title_delta >= 8:
        return f"The season scenario suggests meaningful championship upside while adding {current:+.1f} projected lineup points."
    if remaining is not None and remaining >= 2:
        return f"The move adds {remaining:+.1f} projected lineup points per week across the available remaining-season horizon."
    if result.fairness < -5 and current >= 3 and context.window in {"Win Now", "Competing"}:
        return f"The modeled overpay buys {current:+.1f} weekly points and {playoff:+.1f} playoff points—a contender move, not a value-arbitrage move."
    if len(result.lineup_a.internal_replacements) and current >= 2:
        return f"Your roster replaces the outgoing production internally while adding {current:+.1f} projected lineup points."
    if current >= 4 or playoff >= 5:
        return f"This materially raises the team's ceiling: {current:+.1f} current and {playoff:+.1f} playoff lineup points."
    if result.lineup_a.depth_change >= 5:
        return "The move improves lineup flexibility and reduces the cost of a future injury."
    return "The recommendation balances market cost with the improvement to your usable starting roster."


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
    context: TeamContext | None = None,
    send_players: tuple[Player, ...] | list[Player] = (),
    receive_players: tuple[Player, ...] | list[Player] = (),
    role_risk_penalty: float = 0.0,
) -> tuple[int, int, int, tuple[tuple[str, float], ...]]:
    market = max(-25.0, min(25.0, result.fairness))
    lineup = max(-10.0, min(10.0, result.lineup_a.points_gained))
    fit = max(-20.0, min(20.0, result.fit_a))
    depth = max(-25.0, min(25.0, result.lineup_a.depth_change))
    playoff = max(-10.0, min(10.0, result.lineup_a.playoff_points_gained or 0))
    remaining = max(-10.0, min(10.0, result.lineup_a.remaining_season_points_gained or 0))
    lineup_weight = {"Conservative": 1.9, "Balanced": 2.4, "Aggressive": 2.9}[risk_profile]
    playoff_weight = {"Conservative": 1.4, "Balanced": 1.9, "Aggressive": 2.3}[risk_profile]
    depth_weight = {"Conservative": 1.15, "Balanced": .75, "Aggressive": .40}[risk_profile]
    win_now = context.win_now_weight if context else .5
    leverage = win_now * (max(0.0, lineup) * 1.0 + max(0.0, playoff) * .7)
    consolidation = 0.0
    if result.lineup_a.received_player_starts and len(send_players) > len(receive_players):
        consolidation = min(6.0, (len(send_players) - len(receive_players)) * 1.8 + max(0.0, lineup) * .45)
    internal_replacements = len(result.lineup_a.internal_replacements)
    uncovered_starters = max(0, len(result.lineup_a.outgoing_starters) - internal_replacements)
    replaceability = internal_replacements * 1.5 - uncovered_starters * 1.75
    churn = -8.0 if lineup < 1 and playoff < 2 and not is_sell else 0.0
    components = (
        ("Base team utility", 45.0),
        ("Current lineup", lineup * lineup_weight),
        ("Remaining-season lineup", remaining * 1.5),
        ("Playoff lineup", playoff * playoff_weight),
        ("Timeline and need fit", fit * .35),
        ("Roster resilience", depth * depth_weight),
        ("Championship leverage", leverage),
        ("Starter concentration", consolidation),
        ("Internal replaceability", replaceability),
        ("Recent role stability", -role_risk_penalty),
        ("Positional need", target_need * .10),
        ("Empty-churn penalty", churn),
    )
    team_value = sum(value for _, value in components)
    if is_sell:
        components = (("Base team utility", 45.0), ("Timeline fit", fit * .6), ("Future flexibility", max(0.0, market) * .35))
        team_value = sum(value for _, value in components)
    team_score = round(max(0, min(100, team_value)))
    market_score = round(max(0, min(100, 50 + market * 1.5)))
    # Team utility leads. Market cost and partner fit constrain an idea without
    # vetoing a justified contender overpay.
    raw = team_score * .62 + result.acceptance_score * .28 + market_score * .10
    score = round(max(0, min(100, raw)))
    breakdown = components + (
        ("Team-value contribution", team_score * .62),
        ("Partner-fit contribution", result.acceptance_score * .28),
        ("Market fairness", market_score * .10),
    )
    return score, team_score, market_score, tuple((label, round(value, 1)) for label, value in breakdown)


def _short_horizon_penalty(player: Player | None) -> tuple[float, str | None]:
    if player is None or player.age <= 0:
        return 0.0, None
    thresholds = {"QB": (35, 37, 39), "RB": (27, 29, 31), "WR": (29, 31, 33), "TE": (30, 32, 34)}
    early, high, severe = thresholds.get(player.position, (99, 99, 99))
    if player.age >= severe:
        return 24.0, f"Severe short-horizon risk: {player.name} is age {player.age}"
    if player.age >= high:
        return 16.0, f"High short-horizon risk: {player.name} is age {player.age}"
    if player.age >= early:
        return 8.0, f"Moderate short-horizon risk: {player.name} is age {player.age}"
    return 0.0, None


def _qb_role_risk(player: Player | None, league: League) -> tuple[float, str | None]:
    """Detect bridge QBs whose role is threatened by a valuable young teammate."""
    if player is None or player.position != "QB":
        return 0.0, None
    role = league.player_roles.get(player.id, {})
    try:
        player_order = int(role.get("depth_chart_order") or 0)
    except (TypeError, ValueError):
        player_order = 0
    if player_order >= 2:
        return 28.0, f"Severe role-security risk: the provider depth chart lists {player.name} as QB{player_order}"
    if player.age <= 0 or player.age < 32:
        return 0.0, None
    league_players = [asset for roster in league.rosters for asset in roster.players] + list(league.free_agents)
    challengers = [
        asset for asset in league_players
        if asset.id != player.id and asset.position == "QB" and asset.team == player.team
        and 0 < asset.age <= 25 and asset.value >= max(12, player.value * .45)
    ]
    if not challengers:
        return 0.0, None
    challenger = max(challengers, key=lambda asset: asset.value)
    if player.age >= 35 or challenger.value >= player.value * .80:
        return 22.0, f"Severe role-security risk: {challenger.name} is a valuable young QB behind {player.name}"
    return 12.0, f"Elevated role-security risk: {challenger.name} could replace {player.name}"


def _rental_pick_blocked(
    target: Player,
    pick: DraftPick,
    risk_profile: RiskProfile,
    result: TradeResult,
    role_risk: float = 0.0,
) -> bool:
    if target.position != "QB" or pick.round > 2:
        return False
    immediate = result.lineup_a.points_gained
    playoff = result.lineup_a.playoff_points_gained or 0
    if target.age >= 39 or role_risk >= 20:
        return risk_profile != "Aggressive" or (immediate < 3 and playoff < 4)
    if target.age >= 37 and risk_profile == "Conservative":
        return True
    return False


def _waiver_alternative_penalty(target: Player | None, league: League) -> tuple[float, str | None]:
    """Price the opportunity cost of trading for production available for free."""
    if target is None:
        return 0.0, None
    available = [
        player for player in league.free_agents
        if player.position == target.position
        and (player.injury_status or "active").lower() not in {"out", "o", "ir", "pup", "nfi", "suspended", "sus", "doubtful", "d"}
    ]
    if not available:
        return 0.0, None
    alternative = max(available, key=lambda player: (projected_points(player, league), player.value))
    target_points = projected_points(target, league)
    alternative_points = projected_points(alternative, league)
    if alternative_points <= 0:
        return 0.0, None
    if target_points <= 0 or alternative_points >= target_points * .85:
        return 20.0, f"Waiver alternative: {alternative.name} offers similar immediate {target.position} production without trading an asset"
    if alternative_points >= target_points * .70:
        return 10.0, f"Waiver alternative: {alternative.name} provides much of the same immediate {target.position} production"
    return 0.0, None


def _depth_score(
    result: TradeResult,
    target_need: float,
    target: Player | None = None,
    sent_pick: DraftPick | None = None,
    league: League | None = None,
) -> tuple[int, tuple[tuple[str, float], ...]]:
    """Score insurance moves primarily by the protection they buy the user."""
    horizon_penalty, _ = _short_horizon_penalty(target)
    combined_role_penalty, _ = _combined_role_risk(target, league) if league else (0.0, ())
    waiver_penalty, _ = _waiver_alternative_penalty(target, league) if league else (0.0, None)
    immediate_gain = max(0.0, result.lineup_a.points_gained)
    playoff_gain = max(0.0, result.lineup_a.playoff_points_gained or 0)
    if immediate_gain >= 3 or playoff_gain >= 4:
        horizon_penalty *= .75
    pick_opportunity_cost = 0.0
    if sent_pick and sent_pick.round <= 2 and immediate_gain < 1 and playoff_gain < 2:
        pick_opportunity_cost = 15.0 if sent_pick.round == 2 else 28.0
    if sent_pick and horizon_penalty >= 12:
        pick_opportunity_cost += 8.0 if sent_pick.round == 2 else 18.0 if sent_pick.round == 1 else 0.0
    components = (
        ("Base", 50.0),
        ("Resilience improvement", min(32.0, max(0.0, result.lineup_a.depth_change) * 2.0)),
        ("Playoff insurance", min(8.0, playoff_gain * 1.2)),
        ("Current lineup", min(4.0, immediate_gain)),
        ("Positional urgency", min(5.0, target_need * .05)),
        ("Market balance", max(-4.0, min(4.0, result.fairness * .3))),
        ("Partner viability", max(-3.0, min(5.0, (result.acceptance_score - 50) * .1))),
        ("Short-horizon cost", -horizon_penalty),
        ("Role-security cost", -combined_role_penalty),
        ("Free-agent alternative cost", -waiver_penalty),
        ("Pick opportunity cost", -pick_opportunity_cost),
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
    unavailable = [
        asset for asset in assets
        if isinstance(asset, Player)
        and (asset.injury_status or "").lower() in {"out", "o", "ir", "pup", "nfi", "suspended", "sus"}
    ]
    if unavailable:
        score -= min(24, len(unavailable) * 12)
        reasons.append(f"{len(unavailable)} player{'s are' if len(unavailable) != 1 else ' is'} currently unavailable")
    players = [asset for asset in assets if isinstance(asset, Player)]
    disputed_market = [player for player in players if value_profile(player, league).source_disagreement >= 25]
    if disputed_market:
        score -= min(16, len(disputed_market) * 8)
        reasons.append(f"Market sources disagree materially on {', '.join(player.name for player in disputed_market[:2])}")
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
                combined = offer.value + pick_profile(pick, league).adjusted_value
                if .65 * target_value <= combined <= 1.35 * target_value:
                    packages.append(([offer], [pick]))
    for first, second in combinations(ranked[:8], 2):
        combined = first.value + second.value
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
            + sum(pick_profile(pick, league).adjusted_value for pick in package[1])
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
            value = target.value + pick_profile(pick, league).adjusted_value
            packages.append(((target,), (pick,), value))
    secondary = sorted(
        (
            player for player in tradable_roster_players(partner)
            if player.id != target.id and 5 <= player.value <= max(12, target.value * .50)
        ),
        key=lambda player: (abs(player.value - target.value * .25), -player.value),
    )[:1]
    for player in secondary:
        packages.append(((target, player), (), target.value + player.value))
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
    user_context: TeamContext | None = None,
    allow_nonstarting_target: bool = False,
) -> str | None:
    """Reject only unsafe or non-viable packages; rank ordinary tradeoffs later."""
    unavailable_statuses = {"out", "o", "ir", "pup", "nfi", "suspended", "sus", "doubtful", "d"}
    unavailable_incoming = [
        player for player in receive_players
        if (player.injury_status or "active").lower() in unavailable_statuses
    ]
    if user_context and user_context.window in {"Win Now", "Competing"} and len(unavailable_incoming) >= 2:
        return "Multiple unavailable incoming players"
    if (
        target is not None
        and user_context
        and user_context.window in {"Win Now", "Competing"}
        and target.name not in result.lineup_a.new_starters
        and not allow_nonstarting_target
    ):
        return "Target does not enter starting lineup"
    if not _passes_qb_asset_safety(result, send_players, receive_players, league):
        return "QB asset safety"
    if not result.lineup_a.received_player_starts and receive_players and not allow_nonstarting_target:
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
    if score >= 72 and result.acceptance_score >= 48 and abs(result.fairness) <= 12 and current >= 1 and depth >= -10 and not result.lineup_a.critical_positions:
        return "Best fit"
    if risk_profile == "Aggressive" and score >= 56 and (current >= 2 or playoff >= 4) and depth >= -20:
        return "Aggressive upside"
    if score >= 62 and result.acceptance_score >= 48 and abs(result.fairness) <= 18 and current >= .5 and depth >= (-6 if risk_profile == "Conservative" else -14):
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
        f"Projected remaining-season lineup change: {result.lineup_a.remaining_season_points_gained:+.1f} PPG across weeks {', '.join(map(str, result.lineup_a.remaining_season_weeks_modeled))}" if result.lineup_a.remaining_season_points_gained is not None else "Future regular-season projections are not yet available",
        f"Projected playoff-lineup change: {result.lineup_a.playoff_points_gained:+.1f} PPG across weeks {', '.join(map(str, result.lineup_a.playoff_weeks_modeled))}" if result.lineup_a.playoff_points_gained is not None else "Playoff-week projections are not yet available",
        f"Roster resilience: {result.lineup_a.before_resilience} → {result.lineup_a.after_resilience} ({result.lineup_a.depth_change:+.0f})",
        f"Partner-fit heuristic: {result.acceptance_score}/100",
        f"Simulated playoff odds: {result.playoff_probability_before:.1f}% → {result.playoff_probability_after:.1f}% · championship odds: {result.championship_probability_before:.1f}% → {result.championship_probability_after:.1f}%" if result.playoff_probability_before is not None and result.playoff_probability_after is not None and result.championship_probability_before is not None and result.championship_probability_after is not None else "Before-and-after season outcome simulation is unavailable",
    )
    cautions: list[str] = []
    if not league.weekly_points:
        cautions.append("Weekly projections are unavailable; lineup impact uses scored season averages.")
    if result.acceptance_score < 50:
        cautions.append("The other roster receives a below-neutral fit; negotiation may require a different secondary asset.")
    if abs(result.fairness) > 12:
        cautions.append("The package is near the outer market-fairness limit.")
    if result.lineup_a.introduced_coverage_warnings:
        cautions.append("The trade creates or worsens coverage risk: " + "; ".join(result.lineup_a.introduced_coverage_warnings))
    elif result.lineup_a.existing_coverage_warnings:
        cautions.append("Existing roster coverage remains unresolved: " + "; ".join(result.lineup_a.existing_coverage_warnings))
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
        _metrics["full_evaluations"] = 0

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
                full_evaluations_by_return: dict[tuple[tuple[str, ...], tuple[str, ...]], int] = {}
                for receive_players, receive_picks, return_value in _return_packages(target, partner, league):
                    return_key = (
                        tuple(sorted(player.id for player in receive_players)),
                        tuple(sorted(pick.label for pick in receive_picks)),
                    )
                    packages = _candidate_packages(return_value, expendable, my_team.draft_picks, partner, league, contexts)
                    for send_players, send_picks in packages:
                        result = evaluate_trade(
                            my_team, partner, send_players, list(receive_players), league,
                            send_picks, list(receive_picks), contexts, model_playoffs=False,
                        )
                        if _metrics is not None:
                            _metrics["packages_evaluated"] += 1
                        gate_reason = _hard_gate_reason(result, send_players, receive_players, send_picks, league, target, my_context)
                        if gate_reason:
                            reject(gate_reason)
                            continue
                        # Market-nearest offers are generated first. Preserve at
                        # most two per return shape for expensive multi-week
                        # optimization, while still testing direct, pick-back,
                        # and player-back constructions independently.
                        if full_evaluations_by_return.get(return_key, 0) >= 1:
                            reject("Staged simulation limit")
                            continue
                        full_evaluations_by_return[return_key] = full_evaluations_by_return.get(return_key, 0) + 1
                        # Playoff-week optimization is substantially more expensive.
                        # Run it only after the package clears current-week, market,
                        # depth, and partner screens.
                        result = evaluate_trade(
                            my_team, partner, send_players, list(receive_players), league,
                            send_picks, list(receive_picks), contexts, model_outcomes=False,
                        )
                        if _metrics is not None:
                            _metrics["full_evaluations"] += 1
                        combined_role_penalty, role_warnings = _combined_role_risk(target, league)
                        if combined_role_penalty >= 18 and (
                            risk_profile != "Aggressive"
                            or (result.lineup_a.points_gained < 3 and (result.lineup_a.playoff_points_gained or 0) < 4)
                        ):
                            reject("Unstable starting role")
                            continue
                        score, team_score, market_score, breakdown = _score(
                            result, need, risk_profile=risk_profile, context=my_context,
                            send_players=send_players, receive_players=receive_players,
                            role_risk_penalty=combined_role_penalty,
                        )
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
                        reason += " " + _strategic_summary(result, my_context)
                        evidence, cautions = _evidence(result, league, my_context, partner)
                        for warning in reversed(role_warnings):
                            cautions = (warning + "; verify the latest status before offering.", *cautions)
                        confidence_assets = tuple(send_players) + tuple(send_picks) + receive_players + receive_picks
                        confidence, confidence_reasons = _confidence(league, my_context, partner, confidence_assets, outlooks)
                        if confidence not in {"A", "B"} and not include_low_confidence:
                            reject("Evidence confidence")
                            continue
                        score, confidence_adjustment = _evidence_adjusted_score(score, confidence)
                        breakdown = (*breakdown, ("Evidence confidence", confidence_adjustment))
                        tier = _recommendation_tier(result, score, risk_profile)
                        if tier is None:
                            if score >= 48 and include_review_candidates:
                                tier = "Exploratory"
                            else:
                                reject("Insufficient evidence-adjusted upside")
                                continue
                        if tier == "Exploratory" and not include_review_candidates:
                            reject("Exploratory hidden")
                            continue
                        score_low, score_high = _score_range(score, confidence, team_score, market_score)
                        recommendation = Recommendation(
                            kind="BUY", partner=partner, send_players=tuple(send_players), send_picks=tuple(send_picks),
                            receive_players=receive_players, receive_picks=receive_picks, evaluation=result, score=score, reason=reason,
                            objective=_buy_objective(tuple(send_players), receive_players, receive_picks), tier=tier,
                            team_value_score=team_score, market_value_score=market_score,
                            score_low=score_low, score_high=score_high,
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
                    result = evaluate_trade(my_team, partner, [], [target], league, [pick], [], contexts, model_outcomes=False)
                    if _metrics is not None:
                        _metrics["full_evaluations"] += 1
                    combined_role_penalty, role_warnings = _combined_role_risk(target, league)
                    waiver_penalty, waiver_warning = _waiver_alternative_penalty(target, league)
                    if _rental_pick_blocked(target, pick, risk_profile, result, combined_role_penalty):
                        reject("Premium pick for unstable QB rental")
                        continue
                    immediate_gain = result.lineup_a.points_gained
                    playoff_gain = result.lineup_a.playoff_points_gained or 0
                    if pick.round <= 2 and immediate_gain < 1 and playoff_gain < 2 and combined_role_penalty >= 8:
                        reject("Premium pick for volatile depth asset")
                        continue
                    if pick.round <= 2 and immediate_gain < 2 and waiver_penalty >= 20:
                        reject("Trade cost exceeds waiver alternative")
                        continue
                    score, breakdown = _depth_score(
                        result, my_context.position_needs.get(target.position, 0), target, pick, league,
                    )
                    if score < 50:
                        reject("Insufficient insurance value")
                        continue
                    tier = "Best fit" if score >= 75 else "Balanced option" if score >= 62 else "Exploratory"
                    try:
                        near_term_pick = pick.year <= int(league.season) + 1
                    except (TypeError, ValueError):
                        near_term_pick = True
                    if pick.round <= 2 and near_term_pick and immediate_gain < 1 and playoff_gain < 2:
                        tier = "Exploratory"
                    horizon_penalty, horizon_warning = _short_horizon_penalty(target)
                    if horizon_penalty >= 16:
                        tier = "Balanced option" if score >= 62 and (result.lineup_a.points_gained >= 3 or (result.lineup_a.playoff_points_gained or 0) >= 4) else "Exploratory"
                    if tier == "Exploratory" and not include_review_candidates:
                        reject("Exploratory hidden")
                        continue
                    confidence, confidence_reasons = _confidence(league, my_context, partner, (pick, target), outlooks)
                    if confidence not in {"A", "B"} and not include_low_confidence:
                        reject("Evidence confidence")
                        continue
                    score, confidence_adjustment = _evidence_adjusted_score(score, confidence)
                    breakdown = (*breakdown, ("Evidence confidence", confidence_adjustment))
                    tier = "Best fit" if score >= 75 else "Balanced option" if score >= 62 else "Exploratory"
                    if pick.round <= 2 and near_term_pick and immediate_gain < 1 and playoff_gain < 2:
                        tier = "Exploratory"
                    if horizon_penalty >= 16:
                        tier = "Balanced option" if score >= 62 and (immediate_gain >= 3 or playoff_gain >= 4) else "Exploratory"
                    if tier == "Exploratory" and not include_review_candidates:
                        reject("Exploratory hidden")
                        continue
                    evidence, cautions = _evidence(result, league, my_context, partner)
                    if horizon_warning:
                        cautions = (horizon_warning + "; treat this as a short-term rental, not retained dynasty value.", *cautions)
                    if waiver_warning:
                        cautions = (waiver_warning + ".", *cautions)
                    for warning in reversed(role_warnings):
                        cautions = (warning + "; verify the latest status before offering.", *cautions)
                    role_reason = (
                        f"Adds {target.name} to the projected starting lineup"
                        if target.name in result.lineup_a.new_starters
                        else f"Adds short-term {target.position} insurance"
                    )
                    depth_market_score = round(max(0, min(100, 50 + result.fairness * 1.5)))
                    score_low, score_high = _score_range(score, confidence, score, depth_market_score)
                    ideas.append(Recommendation(
                        kind="DEPTH", partner=partner, send_players=(), send_picks=(pick,),
                        receive_players=(target,), receive_picks=(), evaluation=result, score=score,
                        reason=f"{role_reason} and raises roster resilience from {result.lineup_a.before_resilience} to {result.lineup_a.after_resilience}.",
                        objective="Depth insurance", tier=tier,
                        team_value_score=score, market_value_score=depth_market_score,
                        score_low=score_low, score_high=score_high,
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
                    result = evaluate_trade(my_team, partner, [player], [], league, [], list(pick_package), contexts, model_outcomes=False)
                    if _metrics is not None:
                        _metrics["full_evaluations"] += 1
                    capital = ", ".join(pick.label for pick in pick_package)
                    reason = f"Moves an aging {player.position} into {capital} while {partner.team_name} adds a win-now contributor."
                    evidence, cautions = _evidence(result, league, my_context, partner)
                    score, team_score, market_score, breakdown = _score(
                        result, 0, True, risk_profile, my_context, [player], [],
                    )
                    tier = "Best fit" if score >= 72 else "Balanced option" if score >= 62 else "Exploratory" if score >= 52 else None
                    if tier is None or (tier == "Exploratory" and not include_review_candidates):
                        reject("Insufficient strategic upside")
                        continue
                    confidence, confidence_reasons = _confidence(league, my_context, partner, (player, *pick_package), outlooks)
                    if score < (55 if include_low_confidence else 60):
                        continue
                    if confidence not in {"A", "B"} and not include_low_confidence:
                        continue
                    score, confidence_adjustment = _evidence_adjusted_score(score, confidence)
                    breakdown = (*breakdown, ("Evidence confidence", confidence_adjustment))
                    tier = "Best fit" if score >= 72 else "Balanced option" if score >= 62 else "Exploratory" if score >= 52 else None
                    if tier is None or (tier == "Exploratory" and not include_review_candidates):
                        continue
                    score_low, score_high = _score_range(score, confidence, team_score, market_score)
                    partner_candidates.append(Recommendation(
                        kind="SELL", partner=partner, send_players=(player,), send_picks=(), receive_players=(),
                        receive_picks=pick_package, evaluation=result, score=score, reason=reason, evidence=evidence,
                        objective="Future value", tier=tier,
                        team_value_score=team_score, market_value_score=market_score,
                        score_low=score_low, score_high=score_high,
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
    selected = diversify_recommendations(ranked, limit)
    if any(roster.games_played for roster in league.rosters):
        hydrated: list[Recommendation] = []
        for idea in selected:
            evaluation = evaluate_trade(
                    my_team,
                    idea.partner,
                    list(idea.send_players),
                    list(idea.receive_players),
                    league,
                    list(idea.send_picks),
                    list(idea.receive_picks),
                    contexts,
                )
            scenario_evidence = (
                f"Simulated playoff odds: {evaluation.playoff_probability_before:.1f}% → {evaluation.playoff_probability_after:.1f}% · "
                f"championship odds: {evaluation.championship_probability_before:.1f}% → {evaluation.championship_probability_after:.1f}%"
            )
            evidence = tuple(
                scenario_evidence if item == "Before-and-after season outcome simulation is unavailable" else item
                for item in idea.evidence
            )
            hydrated.append(replace(idea, evaluation=evaluation, evidence=evidence))
        selected = hydrated
    return selected


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
        metrics.get("full_evaluations", 0),
    )
    record_event(
        "recommendation_search_completed",
        duration_ms=performance.elapsed_ms,
        packages=performance.packages_evaluated,
        viable=performance.viable_candidates,
        returned=len(ideas),
        full_evaluations=performance.full_evaluations,
        risk_profile=risk_profile,
        target_position=target_position,
    )
    return ideas, performance


def _target_offer_packages(
    target_value: float,
    my_team: Roster,
    partner: Roster,
    league: League,
    contexts: dict[str, TeamContext],
) -> list[tuple[list[Player], list[DraftPick]]]:
    """Build bounded, market-plausible offers for one explicitly selected player."""
    partner_needs = contexts[partner.team_id].position_needs
    players = sorted(
        (player for player in tradable_roster_players(my_team) if player.value >= 8),
        key=lambda player: (partner_needs.get(player.position, 0), player.value),
        reverse=True,
    )[:12]
    candidates: list[tuple[list[Player], list[DraftPick]]] = []
    candidates.extend(([player], []) for player in players)
    candidates.extend(([first, second], []) for first, second in combinations(players[:10], 2))
    if league.mode != "redraft":
        priced_picks = sorted(
            my_team.draft_picks,
            key=lambda pick: pick_profile(pick, league).adjusted_value,
            reverse=True,
        )[:6]
        candidates.extend(([], [pick]) for pick in priced_picks)
        candidates.extend(([player], [pick]) for player in players[:10] for pick in priced_picks)
        candidates.extend(([], [first, second]) for first, second in combinations(priced_picks, 2))

    viable: dict[tuple[tuple[str, ...], tuple[tuple[int, int, str], ...]], tuple[list[Player], list[DraftPick]]] = {}
    for send_players, send_picks in candidates:
        offered = package_value(send_players, send_picks, league)
        if not (.50 * target_value <= offered <= 1.55 * target_value):
            continue
        key = (
            tuple(sorted(player.id for player in send_players)),
            tuple(sorted((pick.year, pick.round, pick.original_owner) for pick in send_picks)),
        )
        viable[key] = (send_players, send_picks)
    return sorted(
        viable.values(),
        key=lambda package: abs(package_value(package[0], package[1], league) - target_value),
    )[:30]


def generate_target_offers(
    league: League,
    target_player_id: str,
    limit: int = 5,
    risk_profile: RiskProfile = "Balanced",
    required_send_player_id: str | None = None,
) -> tuple[list[Recommendation], RecommendationSearchPerformance]:
    """Find credible direct paths to a specific player on another roster."""
    started = monotonic()
    if league.values_status != "live":
        return [], RecommendationSearchPerformance(0, 0, 0, rejection_counts=(("Market values unavailable", 1),))
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    owner = next(
        (roster for roster in league.rosters if roster.team_id != my_team.team_id and any(player.id == target_player_id for player in roster.players)),
        None,
    )
    if owner is None:
        return [], RecommendationSearchPerformance(0, 0, 0, rejection_counts=(("Target is not held by another roster", 1),))
    target = next(player for player in owner.players if player.id == target_player_id)
    contexts = build_contexts(league)
    my_context = contexts[my_team.team_id]
    outlooks = {profile.player.id: profile for profile in compute_projection_profiles(league)}
    rejections: dict[str, int] = {}
    evaluated = 0
    viable = 0
    offers: list[Recommendation] = []
    need = my_context.position_needs.get(target.position, 0)
    for receive_players, receive_picks, return_value in _return_packages(target, owner, league):
        for send_players, send_picks in _target_offer_packages(return_value, my_team, owner, league, contexts):
            if required_send_player_id and required_send_player_id not in {player.id for player in send_players}:
                continue
            result = evaluate_trade(
                my_team, owner, send_players, list(receive_players), league,
                send_picks, list(receive_picks), contexts, model_playoffs=False,
            )
            evaluated += 1
            reason = _hard_gate_reason(
                result, send_players, receive_players, send_picks, league, target, my_context,
                allow_nonstarting_target=league.mode != "redraft" and (
                    target.id in set(owner.reserve_player_ids) | set(owner.taxi_player_ids)
                    or (target.injury_status or "").lower() in {"out", "o", "ir", "pup", "nfi", "suspended", "sus"}
                ),
            )
            if reason:
                rejections[reason] = rejections.get(reason, 0) + 1
                continue
            result = evaluate_trade(
                my_team, owner, send_players, list(receive_players), league,
                send_picks, list(receive_picks), contexts,
            )
            combined_role_penalty, role_warnings = _combined_role_risk(target, league)
            if combined_role_penalty >= 18 and (
                risk_profile != "Aggressive"
                or (result.lineup_a.points_gained < 3 and (result.lineup_a.playoff_points_gained or 0) < 4)
            ):
                rejections["Unstable starting role"] = rejections.get("Unstable starting role", 0) + 1
                continue
            score, team_score, market_score, breakdown = _score(
                result, need, risk_profile=risk_profile, context=my_context,
                send_players=send_players, receive_players=receive_players,
                role_risk_penalty=combined_role_penalty,
            )
            # A target search may tolerate a small present-lineup cost for a prized
            # dynasty asset, but it should never describe a lowball as a path.
            if score < 50 or result.acceptance_score < 45 or abs(result.fairness) > 18:
                rejections["Insufficient two-sided fit"] = rejections.get("Insufficient two-sided fit", 0) + 1
                continue
            tier = (
                "Strong path" if score >= 70 and result.acceptance_score >= 48
                else "Viable path" if score >= 58
                else "Tradeoff path"
            )
            evidence, cautions = _evidence(result, league, my_context, owner)
            for warning in reversed(role_warnings):
                cautions = (warning + "; verify the latest status before offering.", *cautions)
            assets: tuple[Player | DraftPick, ...] = (*send_players, *send_picks, *receive_players, *receive_picks)
            confidence, confidence_reasons = _confidence(league, my_context, owner, assets, outlooks)
            score, confidence_adjustment = _evidence_adjusted_score(score, confidence)
            breakdown = (*breakdown, ("Evidence confidence", confidence_adjustment))
            tier = (
                "Strong path" if score >= 70 and result.acceptance_score >= 48
                else "Viable path" if score >= 58
                else "Tradeoff path"
            )
            score_low, score_high = _score_range(score, confidence, team_score, market_score)
            offers.append(Recommendation(
                kind="TARGET", partner=owner, send_players=tuple(send_players), send_picks=tuple(send_picks),
                receive_players=receive_players, receive_picks=receive_picks, evaluation=result, score=score,
                reason=f"A direct path to {target.name} built around assets that fit {owner.team_name}. {_strategic_summary(result, my_context)}",
                objective="Acquire target", tier=tier, evidence=evidence, cautions=cautions,
                team_value_score=team_score, market_value_score=market_score,
                score_low=score_low, score_high=score_high,
                confidence=confidence, confidence_reasons=confidence_reasons, score_breakdown=breakdown,
                review_only=tier == "Tradeoff path",
            ))
            viable += 1
    ranked = sorted(
        offers,
        key=lambda idea: (idea.score, idea.evaluation.acceptance_score, -abs(idea.evaluation.fairness)),
        reverse=True,
    )
    # Avoid presenting a page of superficially different packages all built
    # around the same outgoing player.
    selected: list[Recommendation] = []
    player_uses: dict[str, int] = {}
    for offer in ranked:
        if any(player_uses.get(player.id, 0) >= 2 for player in offer.send_players):
            continue
        selected.append(offer)
        for player in offer.send_players:
            player_uses[player.id] = player_uses.get(player.id, 0) + 1
        if len(selected) >= limit:
            break
    performance = RecommendationSearchPerformance(
        round((monotonic() - started) * 1000), evaluated, len(selected), viable,
        tuple(sorted(rejections.items(), key=lambda item: item[1], reverse=True)),
        _team_diagnosis(my_context, league),
    )
    return selected, performance


def _pick_key(pick: DraftPick) -> tuple[int, int, str]:
    return pick.year, pick.round, pick.original_owner


def _apply_recommendation(league: League, idea: Recommendation) -> League:
    """Return an immutable hypothetical league after one recommended trade."""
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    partner = next(roster for roster in league.rosters if roster.team_id == idea.partner.team_id)
    sent_player_ids = {player.id for player in idea.send_players}
    received_player_ids = {player.id for player in idea.receive_players}
    sent_pick_ids = {_pick_key(pick) for pick in idea.send_picks}
    received_pick_ids = {_pick_key(pick) for pick in idea.receive_picks}
    updated_me = replace(
        my_team,
        players=tuple(player for player in my_team.players if player.id not in sent_player_ids) + tuple(idea.receive_players),
        draft_picks=tuple(pick for pick in my_team.draft_picks if _pick_key(pick) not in sent_pick_ids) + tuple(idea.receive_picks),
    )
    updated_partner = replace(
        partner,
        players=tuple(player for player in partner.players if player.id not in received_player_ids) + tuple(idea.send_players),
        draft_picks=tuple(pick for pick in partner.draft_picks if _pick_key(pick) not in received_pick_ids) + tuple(idea.send_picks),
    )
    rosters = tuple(
        updated_me if roster.team_id == updated_me.team_id else updated_partner if roster.team_id == updated_partner.team_id else roster
        for roster in league.rosters
    )
    return replace(league, rosters=rosters, imported_at=f"{league.imported_at or ''}|path:{idea.partner.team_id}:{idea.score}")


def _average_playoff_lineup(roster: Roster, league: League) -> float | None:
    if not league.playoff_weekly_points:
        return None
    totals = [
        optimize_lineup(active_roster_players(roster), replace(league, weekly_points=points)).projected_points
        for points in league.playoff_weekly_points.values()
    ]
    return sum(totals) / len(totals) if totals else None


def generate_multi_step_paths(
    league: League,
    target_player_id: str,
    limit: int = 3,
    risk_profile: RiskProfile = "Balanced",
) -> list[MultiStepPath]:
    """Acquire an owner-fit intermediary, then require it in the target offer."""
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    owner = next(
        (roster for roster in league.rosters if roster.team_id != my_team.team_id and any(player.id == target_player_id for player in roster.players)),
        None,
    )
    if owner is None:
        return []
    target = next(player for player in owner.players if player.id == target_player_id)
    contexts = build_contexts(league)
    owner_needs = contexts[owner.team_id].position_needs
    intermediaries = sorted(
        (
            player
            for roster in league.rosters if roster.team_id not in {my_team.team_id, owner.team_id}
            for player in tradable_roster_players(roster)
            if player.value >= 8
            and .40 * target.value <= player.value <= 1.20 * target.value
            and owner_needs.get(player.position, 0) >= 15
        ),
        key=lambda player: (owner_needs.get(player.position, 0), -abs(player.value - target.value * .72), player.value),
        reverse=True,
    )[:3]
    original_lineup = optimize_lineup(active_roster_players(my_team), league).projected_points
    original_playoff = _average_playoff_lineup(my_team, league)
    paths: list[MultiStepPath] = []
    for intermediary in intermediaries:
        first_offers, _ = generate_target_offers(league, intermediary.id, limit=1, risk_profile=risk_profile)
        if not first_offers:
            continue
        first = first_offers[0]
        hypothetical = _apply_recommendation(league, first)
        second_offers, _ = generate_target_offers(
            hypothetical, target_player_id, limit=3, risk_profile=risk_profile,
            required_send_player_id=intermediary.id,
        )
        second = second_offers[0] if second_offers else None
        if second is None:
            continue
        final_league = _apply_recommendation(hypothetical, second)
        final_team = next(roster for roster in final_league.rosters if roster.team_id == league.my_team_id)
        final_lineup = optimize_lineup(active_roster_players(final_team), final_league).projected_points
        final_playoff = _average_playoff_lineup(final_team, final_league)
        lineup_delta = round(final_lineup - original_lineup, 1)
        playoff_delta = round(final_playoff - original_playoff, 1) if original_playoff is not None and final_playoff is not None else None
        stop_safe = (
            first.score >= 50
            and first.evaluation.lineup_a.points_gained >= 0
            and first.evaluation.lineup_a.depth_change >= -8
            and first.evaluation.lineup_a.after_resilience >= 45
        )
        acceptance_floor = min(first.evaluation.acceptance_score, second.evaluation.acceptance_score)
        execution_risk = "Lower" if acceptance_floor >= 65 and stop_safe else "Moderate" if acceptance_floor >= 50 and stop_safe else "High"
        path_score = round(max(0, min(100,
            first.score * .32 + second.score * .48 + min(14, max(-12, lineup_delta * 2))
            + (4 if playoff_delta is not None and playoff_delta >= 3 else 0)
            - (4 if execution_risk == "Moderate" else 10 if execution_risk == "High" else 0)
        )))
        if path_score >= 48 and (stop_safe or risk_profile == "Aggressive"):
            paths.append(MultiStepPath(
                intermediary, first, second, path_score, lineup_delta, playoff_delta,
                stop_safe, execution_risk,
            ))
    unique: dict[tuple[str, str, str], MultiStepPath] = {}
    for path in sorted(paths, key=lambda item: (item.score, item.final_lineup_delta), reverse=True):
        key = (path.intermediary.id, path.first.partner.team_id, path.second.partner.team_id)
        unique.setdefault(key, path)
    return list(unique.values())[:limit]


def _sell_return_packages(partner: Roster, target_value: float, league: League, context: TeamContext) -> list[tuple[list[Player], list[DraftPick]]]:
    players = sorted(
        (player for player in tradable_roster_players(partner) if player.value >= 6),
        key=lambda player: (context.position_needs.get(player.position, 0), player.value), reverse=True,
    )[:12]
    picks = sorted(partner.draft_picks, key=lambda pick: pick_profile(pick, league).adjusted_value, reverse=True)[:6] if league.mode != "redraft" else []
    packages: list[tuple[list[Player], list[DraftPick]]] = []
    packages.extend(([player], []) for player in players)
    packages.extend(([first, second], []) for first, second in combinations(players[:8], 2))
    packages.extend(([], [pick]) for pick in picks)
    packages.extend(([player], [pick]) for player in players[:8] for pick in picks)
    packages.extend(([], [first, second]) for first, second in combinations(picks, 2))
    viable = [
        package for package in packages
        if .55 * target_value <= package_value(package[0], package[1], league) <= 1.50 * target_value
    ]
    return sorted(viable, key=lambda package: abs(package_value(package[0], package[1], league) - target_value))[:18]


def generate_sell_offers(
    league: League,
    player_id: str,
    limit: int = 5,
    risk_profile: RiskProfile = "Balanced",
) -> tuple[list[Recommendation], RecommendationSearchPerformance]:
    """Find credible destinations and team-improving returns for one roster player."""
    started = monotonic()
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    target = next((player for player in my_team.players if player.id == player_id), None)
    if target is None:
        return [], RecommendationSearchPerformance(0, 0, 0, rejection_counts=(("Player is not on your roster", 1),))
    contexts = build_contexts(league)
    my_context = contexts[my_team.team_id]
    outlooks = {profile.player.id: profile for profile in compute_projection_profiles(league)}
    evaluated = 0
    viable = 0
    rejections: dict[str, int] = {}
    offers: list[Recommendation] = []

    def reject(reason: str) -> None:
        rejections[reason] = rejections.get(reason, 0) + 1

    for partner in league.rosters:
        if partner.team_id == my_team.team_id:
            continue
        for receive_players, receive_picks in _sell_return_packages(partner, target.value, league, my_context):
            evaluated += 1
            result = evaluate_trade(
                my_team, partner, [target], receive_players, league, [], receive_picks, contexts,
                model_playoffs=False,
            )
            primary = max(receive_players, key=lambda player: player.value, default=None)
            reason = _hard_gate_reason(result, [target], receive_players, [], league, primary, my_context)
            if reason:
                reject(reason)
                continue
            if result.acceptance_score < 42 or abs(result.fairness) > 18:
                reject("Insufficient two-sided fit")
                continue
            result = evaluate_trade(my_team, partner, [target], receive_players, league, [], receive_picks, contexts)
            role_penalty, role_warnings = _combined_role_risk(primary, league)
            if role_penalty >= 18 and risk_profile != "Aggressive":
                reject("Unstable return asset")
                continue
            need = max((my_context.position_needs.get(player.position, 0) for player in receive_players), default=0)
            score, team_score, market_score, breakdown = _score(
                result, need, risk_profile=risk_profile, context=my_context,
                send_players=[target], receive_players=receive_players, role_risk_penalty=role_penalty,
            )
            if score < 48:
                reject("Insufficient strategic upside")
                continue
            tier = "Strong exit" if score >= 70 else "Viable exit" if score >= 58 else "Exploratory exit"
            evidence, cautions = _evidence(result, league, my_context, partner)
            for warning in reversed(role_warnings):
                cautions = (warning + "; verify the latest status before offering.", *cautions)
            assets: tuple[Player | DraftPick, ...] = (target, *receive_players, *receive_picks)
            confidence, confidence_reasons = _confidence(league, my_context, partner, assets, outlooks)
            score, confidence_adjustment = _evidence_adjusted_score(score, confidence)
            breakdown = (*breakdown, ("Evidence confidence", confidence_adjustment))
            tier = "Strong exit" if score >= 70 else "Viable exit" if score >= 58 else "Exploratory exit"
            low, high = _score_range(score, confidence, team_score, market_score)
            offers.append(Recommendation(
                kind="SELL", partner=partner, send_players=(target,), send_picks=(),
                receive_players=tuple(receive_players), receive_picks=tuple(receive_picks), evaluation=result,
                score=score, reason=f"Moves {target.name} to {partner.team_name} for a return shaped around your roster needs. {_strategic_summary(result, my_context)}",
                objective="Move selected player", tier=tier, team_value_score=team_score,
                market_value_score=market_score, score_low=low, score_high=high,
                evidence=evidence, cautions=cautions, confidence=confidence,
                confidence_reasons=confidence_reasons, score_breakdown=breakdown,
                review_only=tier == "Exploratory exit",
            ))
            viable += 1
    selected: list[Recommendation] = []
    used_partners: set[str] = set()
    for offer in sorted(offers, key=lambda item: (item.score, item.evaluation.acceptance_score), reverse=True):
        if offer.partner.team_id in used_partners:
            continue
        selected.append(offer)
        used_partners.add(offer.partner.team_id)
        if len(selected) >= limit:
            break
    return selected, RecommendationSearchPerformance(
        round((monotonic() - started) * 1000), evaluated, len(selected), viable,
        tuple(sorted(rejections.items(), key=lambda item: item[1], reverse=True)),
        _team_diagnosis(my_context, league),
    )
