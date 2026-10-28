from __future__ import annotations

from dataclasses import dataclass

from .analytics import active_roster_players, build_contexts, compute_projections, optimize_lineup
from .models import League, Player
from .value_system import protected_player_ids


@dataclass(frozen=True)
class TeamPlan:
    direction: str
    headline: str
    strongest_positions: tuple[str, ...]
    priority_positions: tuple[str, ...]
    protect: tuple[Player, ...]
    shop: tuple[Player, ...]
    actions: tuple[str, ...]


def build_team_plan(league: League) -> TeamPlan:
    roster = next(item for item in league.rosters if item.team_id == league.my_team_id)
    context = build_contexts(league)[roster.team_id]
    ordered_needs = sorted(context.position_needs, key=context.position_needs.get)
    strongest = tuple(ordered_needs[:2])
    priorities = tuple(reversed(ordered_needs[-2:]))
    valuable = sorted((player for player in roster.players if player.value > 0), key=lambda player: player.value, reverse=True)
    protected = protected_player_ids(roster, league)
    protect = tuple(player for player in valuable if player.id in protected)[:4]

    projections = {item.player.id: item for item in compute_projections(league)}
    cliffs = {"RB": 27, "WR": 29, "TE": 30, "QB": 34}
    starter_ids = {player.id for player in optimize_lineup(active_roster_players(roster), league).starters}
    shop = tuple(
        player for player in valuable
        if league.mode != "redraft"
        and player not in protect
        and player.age >= cliffs.get(player.position, 99)
        and projections.get(player.id) is not None
        and projections[player.id].trajectory == "DECLINING"
        and context.position_needs.get(player.position, 0) < 70
        and not (context.window in {"Win Now", "Competing"} and player.position in context.critical_positions)
        and not (context.resilience_score < 60 and player.id in starter_ids)
    )[:3]

    if league.mode == "redraft":
        headline = f"Compete for this season; concentrate value in starters and address {priorities[0]} first."
    elif context.window in {"Win Now", "Competing"}:
        if context.record_rank is not None:
            odds = f" with {context.playoff_probability}% simulated playoff odds" if context.playoff_probability is not None else ""
            deadline = f" {context.deadline_status}." if context.deadline_status != "No deadline" else ""
            resilience = f" Your roster resilience is {context.resilience_label.lower()} ({context.resilience_score}/100)."
            if context.resilience_score < 60 or context.critical_positions:
                positions = ", ".join(context.critical_positions) or priorities[0]
                headline = f"Your {roster.record} record, #{context.points_rank} scoring rank, and {context.contender_confidence.lower()} profile{odds} create a win-now opportunity.{deadline}{resilience} Add playable {positions} insurance before pursuing another starter upgrade."
            else:
                headline = f"Your {roster.record} record, #{context.points_rank} scoring rank, and {context.contender_confidence.lower()} profile{odds} create a win-now opportunity.{deadline}{resilience} Improve {priorities[0]} without creating an injury-sensitive roster."
        else:
            headline = f"Protect the competitive core and use depth or picks to improve {priorities[0]}."
    elif context.window in {"Young Core", "Rebuilding"}:
        headline = f"Preserve young cornerstone value and convert aging production into flexible assets."
    else:
        headline = f"Stay flexible: strengthen {priorities[0]} without sacrificing the long-term core."

    actions = [f"Target a starting-caliber {priorities[0]} whose acquisition improves the optimized lineup."]
    if context.resilience_score < 60 or context.critical_positions:
        positions = ", ".join(context.critical_positions) or priorities[0]
        actions.insert(0, f"Add playable {positions} depth before making another consolidation trade.")
        actions.append("Use future picks or non-starting assets for depth; do not subtract another active contributor.")
    else:
        actions.append(f"Use surplus {strongest[0]} depth as trade value only after preserving a playable replacement.")
    if shop:
        actions.append(f"Test the market for {shop[0].name} before the age curve reduces flexibility.")
    elif league.mode != "redraft" and context.window == "Win Now":
        actions.append("Make future picks available for a durable starter, but keep enough flexibility to absorb injuries.")
    elif league.mode != "redraft":
        actions.append("Keep future picks unless the return clearly changes the starting lineup.")
    else:
        actions.append("Prefer current-week role and availability over long-term age value.")
    return TeamPlan(context.window, headline, strongest, priorities, protect, shop, tuple(actions))
