from __future__ import annotations

from dataclasses import dataclass

from .analytics import TradeResult, build_contexts, compute_projections, evaluate_trade
from .models import DraftPick, League, Player, Roster


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


def _anchor_ids(roster: Roster, league: League) -> set[str]:
    maximum = max((player.value for player in roster.players), default=0)
    return {
        player.id for player in roster.players
        if (league.superflex and player.position == "QB" and player.age <= 27 and player.value >= 55)
        or (player.value == maximum and player.value >= 75)
    }


def _score(result: TradeResult, target_need: float, is_sell: bool = False) -> int:
    market = max(-25.0, min(25.0, result.fairness))
    lineup = max(-10.0, min(10.0, result.lineup_a.points_gained))
    fit = max(-20.0, min(20.0, result.fit_a))
    raw = 50 + market * .7 + lineup * 2 + fit * .35 + target_need * .12 + result.acceptance_score * .10
    if is_sell:
        raw = 50 + market * .5 + fit * .4 + result.acceptance_score * .15
    return round(max(0, min(100, raw)))


def generate_recommendations(league: League, limit: int = 15) -> list[Recommendation]:
    if league.values_status != "live":
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
                if league.mode != "redraft" and target.age > 31 and projections[target.id].trajectory == "DECLINING":
                    continue
                candidates: list[Recommendation] = []
                for offer in expendable:
                    if offer.position == target.position or not (.55 * target.value <= offer.value <= 1.35 * target.value):
                        continue
                    packages: list[tuple[list[Player], list[DraftPick]]] = [([offer], [])]
                    if league.mode != "redraft":
                        packages.extend(([offer], [pick]) for pick in my_team.draft_picks if offer.value + pick.value <= target.value * 1.35)
                    for send_players, send_picks in packages:
                        result = evaluate_trade(my_team, partner, send_players, [target], league, send_picks, [])
                        if result.fairness < -15 or result.acceptance_score < 8:
                            continue
                        if result.lineup_a.points_gained < -1 or not result.lineup_a.received_player_starts:
                            continue
                        score = _score(result, need)
                        reason = f"Addresses your {position} need; {partner.team_name} receives {offer.position} value and an offer-fit score of {result.acceptance_score}/100."
                        candidates.append(Recommendation("BUY", partner, tuple(send_players), tuple(send_picks), (target,), (), result, score, reason))
                if candidates:
                    ideas.append(max(candidates, key=lambda idea: (idea.score, idea.evaluation.acceptance_score)))

    if league.mode != "redraft":
        for player in expendable:
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
                    result = evaluate_trade(my_team, partner, [player], [], league, [], [pick])
                    if result.fairness < -25 or result.acceptance_score < 8:
                        continue
                    reason = f"Moves an aging {player.position} into future capital while {partner.team_name} adds a win-now contributor."
                    ideas.append(Recommendation("SELL", partner, (player,), (), (), (pick,), result, _score(result, 0, True), reason))
                    break

    deduped: dict[tuple[str, str, str], Recommendation] = {}
    for idea in ideas:
        received = idea.receive_players[0].id if idea.receive_players else idea.receive_picks[0].label
        sent = idea.send_players[0].id if idea.send_players else idea.send_picks[0].label
        key = (idea.partner.team_id, sent, received)
        if key not in deduped or idea.score > deduped[key].score:
            deduped[key] = idea
    return sorted(deduped.values(), key=lambda idea: (idea.score, idea.evaluation.acceptance_score), reverse=True)[:limit]
