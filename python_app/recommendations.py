from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

from .analytics import TeamContext, TradeResult, active_roster_players, build_contexts, calc_fppg, compute_projections, evaluate_trade, optimize_lineup, projected_points
from .models import DraftPick, League, Player, Roster
from .value_system import premium_value_cutoff, protected_player_ids


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
    evidence: tuple[str, ...] = ()
    cautions: tuple[str, ...] = ()
    confidence: str = "D"
    confidence_reasons: tuple[str, ...] = ()
    score_breakdown: tuple[tuple[str, float], ...] = ()


def _anchor_ids(roster: Roster, league: League) -> set[str]:
    return protected_player_ids(roster, league)


def _score(result: TradeResult, target_need: float, is_sell: bool = False) -> tuple[int, tuple[tuple[str, float], ...]]:
    market = max(-25.0, min(25.0, result.fairness))
    lineup = max(-10.0, min(10.0, result.lineup_a.points_gained))
    fit = max(-20.0, min(20.0, result.fit_a))
    depth = max(-25.0, min(25.0, result.lineup_a.depth_change))
    playoff = max(-10.0, min(10.0, result.lineup_a.playoff_points_gained or 0))
    components = (
        ("Base", 50.0),
        ("Market fairness", market * .7),
        ("Current lineup", lineup * 2),
        ("Playoff lineup", playoff * 1.5),
        ("Timeline and need fit", fit * .35),
        ("Roster resilience", depth * .8),
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


def _confidence(league: League, context: TeamContext, partner: Roster, assets: tuple[Player | DraftPick, ...]) -> tuple[str, tuple[str, ...]]:
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
    thin_roles = [player for player in players if float(league.player_stats.get(player.id, {}).get("gp") or 0) < 3]
    if thin_roles:
        score -= 12
        reasons.append("At least one player has fewer than three games of season role evidence")
    weak_weekly_evidence = [player for player in players if player.id not in league.weekly_points]
    if weak_weekly_evidence:
        score -= 10
        reasons.append("At least one player lacks a current-week projection")
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
    target: Player,
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
            -abs(player.value - target.value),
        ),
        reverse=True,
    )[:10]
    packages: list[tuple[list[Player], list[DraftPick]]] = []
    for offer in ranked:
        if .55 * target.value <= offer.value <= 1.35 * target.value:
            packages.append(([offer], []))
        if league.mode != "redraft":
            for pick in picks:
                combined = offer.value + pick.value * .9
                if .65 * target.value <= combined <= 1.35 * target.value:
                    packages.append(([offer], [pick]))
    for first, second in combinations(ranked[:8], 2):
        combined = first.value + second.value * .9
        if .7 * target.value <= combined <= 1.3 * target.value:
            packages.append(([first, second], []))
    return packages


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
        if target.value < max(premium_value_cutoff(league), max(pick.value for pick in firsts) * 1.75):
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
) -> list[Recommendation]:
    if league.values_status != "live" or (league.trade_deadline_week is not None and league.current_week > league.trade_deadline_week and any(roster.games_played for roster in league.rosters)):
        return []
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    contexts = build_contexts(league)
    my_context = contexts[my_team.team_id]
    projections = {projection.player.id: projection for projection in compute_projections(league)}
    anchors = _anchor_ids(my_team, league)
    ideas: list[Recommendation] = []

    needs = sorted(my_context.position_needs.items(), key=lambda item: item[1], reverse=True)
    expendable = [player for player in my_team.players if player.id not in anchors and player.value >= 10]
    for position, need in needs:
        if need < 20:
            continue
        for partner in league.rosters:
            if partner.team_id == my_team.team_id:
                continue
            targets = sorted((player for player in partner.players if player.position == position and player.value >= 15), key=lambda player: player.value, reverse=True)[:4]
            for target in targets:
                target_status = (target.injury_status or "active").lower()
                if my_context.window in {"Win Now", "Competing"} and target_status in {"out", "o", "ir", "pup", "nfi", "suspended", "sus", "doubtful", "d"}:
                    continue
                if league.mode != "redraft" and target.age > 31 and projections[target.id].trajectory == "DECLINING":
                    continue
                candidates: list[Recommendation] = []
                packages = _candidate_packages(target, expendable, my_team.draft_picks, partner, league, contexts)
                for send_players, send_picks in packages:
                    result = evaluate_trade(my_team, partner, send_players, [target], league, send_picks, [], contexts)
                    if not result.lineup_a.received_player_starts:
                        continue
                    if not _passes_quality_gates(result, send_players, send_picks, target, league, my_context, contexts[partner.team_id]):
                        continue
                    if my_context.window == "Win Now" and result.lineup_a.playoff_points_gained is not None and result.lineup_a.playoff_points_gained < -1 and result.lineup_a.points_gained < 5:
                        continue
                    score, breakdown = _score(result, need)
                    incoming = ", ".join(sorted({player.position for player in send_players}))
                    reason = f"Addresses your {position} need while {partner.team_name} receives {incoming} value that fits its roster and timeline."
                    evidence, cautions = _evidence(result, league, my_context, partner)
                    confidence, confidence_reasons = _confidence(league, my_context, partner, tuple(send_players) + tuple(send_picks) + (target,))
                    if score < (55 if include_low_confidence else 60):
                        continue
                    if confidence not in {"A", "B"} and not include_low_confidence:
                        continue
                    candidates.append(Recommendation(
                        kind="BUY", partner=partner, send_players=tuple(send_players), send_picks=tuple(send_picks),
                        receive_players=(target,), receive_picks=(), evaluation=result, score=score, reason=reason,
                        evidence=evidence, cautions=cautions, confidence=confidence,
                        confidence_reasons=confidence_reasons, score_breakdown=breakdown,
                    ))
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
                    if not (.65 * target.value <= pick.value <= 1.35 * target.value):
                        continue
                    result = evaluate_trade(my_team, partner, [], [target], league, [pick], [], contexts)
                    if result.acceptance_score < 45 or abs(result.fairness) > 12:
                        continue
                    if result.lineup_a.depth_change < 6 or result.lineup_a.after_resilience <= result.lineup_a.before_resilience:
                        continue
                    score, breakdown = _depth_score(result, my_context.position_needs.get(target.position, 0))
                    confidence, confidence_reasons = _confidence(league, my_context, partner, (pick, target))
                    if confidence not in {"A", "B"} and not include_low_confidence:
                        continue
                    evidence, cautions = _evidence(result, league, my_context, partner)
                    ideas.append(Recommendation(
                        kind="DEPTH", partner=partner, send_players=(), send_picks=(pick,),
                        receive_players=(target,), receive_picks=(), evaluation=result, score=score,
                        reason=f"Adds a playable {target.position} reserve and raises roster resilience from {result.lineup_a.before_resilience} to {result.lineup_a.after_resilience}.",
                        evidence=evidence, cautions=cautions, confidence=confidence,
                        confidence_reasons=confidence_reasons, score_breakdown=breakdown,
                    ))
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
                for pick in sorted(partner.draft_picks, key=lambda item: item.value, reverse=True):
                    if not (.65 * player.value <= pick.value <= 1.35 * player.value):
                        continue
                    result = evaluate_trade(my_team, partner, [player], [], league, [], [pick], contexts)
                    if abs(result.fairness) > 12 or result.acceptance_score < 45:
                        continue
                    reason = f"Moves an aging {player.position} into future capital while {partner.team_name} adds a win-now contributor."
                    evidence, cautions = _evidence(result, league, my_context, partner)
                    score, breakdown = _score(result, 0, True)
                    confidence, confidence_reasons = _confidence(league, my_context, partner, (player, pick))
                    if score < (55 if include_low_confidence else 60):
                        continue
                    if confidence not in {"A", "B"} and not include_low_confidence:
                        continue
                    ideas.append(Recommendation(
                        kind="SELL", partner=partner, send_players=(player,), send_picks=(), receive_players=(),
                        receive_picks=(pick,), evaluation=result, score=score, reason=reason, evidence=evidence,
                        cautions=cautions, confidence=confidence, confidence_reasons=confidence_reasons,
                        score_breakdown=breakdown,
                    ))
                    break

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
    if target_position:
        ranked = [idea for idea in ranked if idea.receive_players and idea.receive_players[0].position == target_position]
    return ranked[:limit]
