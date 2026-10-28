from __future__ import annotations

from dataclasses import dataclass

from .analytics import build_contexts, lineup_impact, optimize_lineup, projected_points
from .models import League, Player
from .value_system import protected_player_ids


@dataclass(frozen=True)
class WaiverRecommendation:
    add: Player
    drop: Player | None
    category: str
    score: int
    lineup_gain: float
    playoff_gain: float | None
    depth_change: float
    value_gain: float
    reason: str
    confidence: str
    cautions: tuple[str, ...] = ()
    suggested_faab: int | None = None
    claim_guidance: str = ""
    confidence_reasons: tuple[str, ...] = ()
    lineup_change: str = ""
    value_band: str = "Neutral"


def _role_evidence(player: Player, league: League) -> tuple[int, str]:
    stats = league.player_stats.get(player.id, {})
    games = float(stats.get("gp") or 0)
    if games <= 0:
        return 0, "No scored-game role sample"
    volume = (
        float(stats.get("pass_att") or 0) if player.position == "QB"
        else float(stats.get("rush_att") or 0) + float(stats.get("tgt") or 0) if player.position == "RB"
        else float(stats.get("tgt") or 0)
    ) / games
    strong = 20 if player.position == "QB" else 10 if player.position == "RB" else 5
    usable = strong * .45
    if games >= 5 and volume >= strong:
        return 2, f"Established role: {games:.0f} games and {volume:.1f} opportunities per game"
    if games >= 3 and volume >= usable:
        return 1, f"Developing role: {games:.0f} games and {volume:.1f} opportunities per game"
    return 0, f"Thin role sample: {games:.0f} games and {volume:.1f} opportunities per game"


def _evidence_grade(player: Player, league: League, contender: bool, category: str) -> tuple[str, tuple[str, ...]]:
    points = 100
    reasons: list[str] = []
    role_level, role_note = _role_evidence(player, league)
    reasons.append(role_note)
    if role_level == 0:
        points -= 35
    elif role_level == 1:
        points -= 10
    if player.id not in league.weekly_points or league.weekly_points.get(player.id, 0) <= 0:
        points -= 20
        reasons.append("No positive current-week projection")
    else:
        reasons.append("Current-week projection is available")
    if contender and not league.playoff_weekly_points:
        points -= 12
        reasons.append("Playoff-week projections are unavailable")
    if category == "DYNASTY STASH":
        points -= 8
        reasons.append("Stash outcomes depend on future role development")
    if (player.injury_status or "").lower() in {"questionable", "q"}:
        points -= 12
        reasons.append("Player currently carries a questionable designation")
    grade = "A" if points >= 85 else "B" if points >= 70 else "C" if points >= 55 else "D"
    return grade, tuple(reasons)


def _value_band(value_gain: float) -> str:
    return "Major gain" if value_gain >= 10 else "Meaningful gain" if value_gain >= 5 else "Modest gain" if value_gain >= 1 else "Neutral" if value_gain >= -1 else "Value loss"


def generate_waiver_recommendations(league: League, limit: int = 20) -> list[WaiverRecommendation]:
    if not league.free_agents:
        return []
    roster = next(item for item in league.rosters if item.team_id == league.my_team_id)
    context = build_contexts(league)[roster.team_id]
    starter_ids = {player.id for player in optimize_lineup(roster.players, league).starters}
    inactive_ids = set(roster.reserve_player_ids) | set(roster.taxi_player_ids)
    unavailable = {"out", "o", "ir", "pup", "nfi", "suspended", "sus", "doubtful", "d"}
    protected = protected_player_ids(roster, league)
    drops = sorted(
        (player for player in roster.players if player.id not in starter_ids and player.id not in protected and player.id not in inactive_ids),
        key=lambda player: (player.value, projected_points(player, league)),
    )[:6]
    capacity = league.active_roster_capacity or sum(count for slot, count in league.roster_slots if slot != "IR")
    active_count = sum(player.id not in inactive_ids for player in roster.players)
    open_spot = active_count < capacity
    candidates = sorted(
        (player for player in league.free_agents if (player.injury_status or "active").lower() not in unavailable),
        key=lambda player: (projected_points(player, league) * 3 + player.value, player.value),
        reverse=True,
    )[:100]
    recommendations: list[WaiverRecommendation] = []
    for add in candidates:
        choices: list[Player | None] = [None] if open_spot else list(drops)
        best: WaiverRecommendation | None = None
        for drop in choices:
            impact = lineup_impact(roster, [drop] if drop else [], [add], league)
            value_gain = add.value - (drop.value if drop else 0)
            need = context.position_needs.get(add.position, 0)
            is_stash = league.mode != "redraft" and add.age > 0 and add.age <= 24 and value_gain >= 4
            if impact.points_gained >= 1:
                category = "STARTER UPGRADE"
                reason = f"Adds {impact.points_gained:+.1f} projected PPG to your optimized lineup."
            elif impact.depth_change >= 4:
                category = "DEPTH UPGRADE"
                thesis = "contingent backfield insurance" if add.position == "RB" else "quarterback injury insurance" if add.position == "QB" else "playable receiving depth"
                reason = f"Adds {thesis} without weakening the starting lineup."
            elif is_stash:
                category = "DYNASTY STASH"
                thesis = "developmental quarterback upside" if add.position == "QB" else "contingent backfield upside" if add.position == "RB" else "a developing receiving-role bet"
                reason = f"Adds {thesis}; the return depends on earning a larger future role."
            else:
                continue
            playoff = impact.playoff_points_gained or 0
            raw_score = 48 + impact.points_gained * 4 + playoff * 2 + impact.depth_change * .7 + value_gain * .8 + need * .08
            if is_stash:
                raw_score += 6
            score = round(max(0, min(100, raw_score)))
            cautions = list(impact.coverage_warnings)
            if not league.weekly_points:
                cautions.append("Current-week projections are unavailable; lineup impact uses season averages.")
            confidence, confidence_reasons = _evidence_grade(add, league, context.window in {"Win Now", "Competing"}, category)
            score = max(0, score - {"A": 0, "B": 2, "C": 6, "D": 12}[confidence])
            if confidence in {"C", "D"}:
                cautions.append("Role evidence is not strong enough to treat this as a dependable weekly contributor.")
            if impact.new_starters:
                lineup_change = f"Enters lineup: {', '.join(impact.new_starters)}"
                if impact.displaced_starters:
                    lineup_change += f" · Displaces: {', '.join(impact.displaced_starters)}"
            else:
                lineup_change = "No immediate starting-lineup change"
            if roster.waiver_budget_remaining is not None:
                if category == "STARTER UPGRADE":
                    rate = .08 + min(.05, max(0, impact.points_gained) * .01)
                elif category == "DEPTH UPGRADE":
                    rate = .025 + min(.04, max(0, impact.depth_change) * .003)
                else:
                    rate = .015 + min(.04, max(0, value_gain) * .002)
                if add.position == "QB" and league.superflex:
                    rate += .035
                if add.position in context.critical_positions:
                    rate += .02
                rate += min(.02, max(0, playoff) * .004)
                rate += min(.015, max(0, value_gain) * .001)
                rate *= {"A": 1.0, "B": .85, "C": .65, "D": .4}[confidence]
                ceiling = .30 if category == "STARTER UPGRADE" else .15 if category == "DEPTH UPGRADE" else .10
                rate = max(.01, min(ceiling, rate))
                suggested_faab = min(roster.waiver_budget_remaining, max(1, round(roster.waiver_budget_remaining * rate))) if roster.waiver_budget_remaining > 0 else 0
                percent = round(suggested_faab / max(roster.waiver_budget_remaining, 1) * 100)
                claim_guidance = f"Bid about {suggested_faab} FAAB · {percent}% of {roster.waiver_budget_remaining} remaining FAAB"
            else:
                suggested_faab = None
                priority = f"#{roster.waiver_position}" if roster.waiver_position is not None else "your current"
                claim_guidance = f"Use {priority} waiver priority" if category == "STARTER UPGRADE" else f"Preserve {priority} priority unless the claim is competitive"
            recommendation = WaiverRecommendation(
                add=add, drop=drop, category=category, score=score,
                lineup_gain=impact.points_gained, playoff_gain=impact.playoff_points_gained,
                depth_change=impact.depth_change, value_gain=value_gain, reason=reason,
                confidence=confidence, cautions=tuple(cautions),
                suggested_faab=suggested_faab, claim_guidance=claim_guidance,
                confidence_reasons=confidence_reasons, lineup_change=lineup_change,
                value_band=_value_band(value_gain),
            )
            if best is None or recommendation.score > best.score:
                best = recommendation
        if best is not None:
            recommendations.append(best)
    return sorted(recommendations, key=lambda item: (item.score, item.lineup_gain, item.value_gain), reverse=True)[:limit]
