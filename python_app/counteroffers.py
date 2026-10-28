from __future__ import annotations

from dataclasses import dataclass

from .analytics import TeamContext, TradeResult, evaluate_trade
from .models import DraftPick, League, Player, Roster
from .value_system import protected_player_ids


@dataclass(frozen=True)
class Counteroffer:
    label: str
    description: str
    team_a_players: tuple[Player, ...]
    team_a_picks: tuple[DraftPick, ...]
    team_b_players: tuple[Player, ...]
    team_b_picks: tuple[DraftPick, ...]
    evaluation: TradeResult
    edits: int


def _pick_key(pick: DraftPick) -> str:
    return f"{pick.year}-{pick.round}-{pick.original_owner}"


def _side_key(players: tuple[Player, ...], picks: tuple[DraftPick, ...]) -> tuple[str, ...]:
    return tuple(sorted([f"p:{player.id}" for player in players] + [f"d:{_pick_key(pick)}" for pick in picks]))


def _edit_count(
    base_a_players: tuple[Player, ...], base_a_picks: tuple[DraftPick, ...],
    base_b_players: tuple[Player, ...], base_b_picks: tuple[DraftPick, ...],
    a_players: tuple[Player, ...], a_picks: tuple[DraftPick, ...],
    b_players: tuple[Player, ...], b_picks: tuple[DraftPick, ...],
) -> int:
    base = set(_side_key(base_a_players, base_a_picks)) | {f"b:{key}" for key in _side_key(base_b_players, base_b_picks)}
    candidate = set(_side_key(a_players, a_picks)) | {f"b:{key}" for key in _side_key(b_players, b_picks)}
    return len(base.symmetric_difference(candidate))


def _describe(
    base_a_players: tuple[Player, ...], base_a_picks: tuple[DraftPick, ...],
    base_b_players: tuple[Player, ...], base_b_picks: tuple[DraftPick, ...],
    a_players: tuple[Player, ...], a_picks: tuple[DraftPick, ...],
    b_players: tuple[Player, ...], b_picks: tuple[DraftPick, ...],
) -> str:
    changes: list[str] = []
    for player in a_players:
        if player not in base_a_players:
            changes.append(f"add {player.name} to your offer")
    for player in base_a_players:
        if player not in a_players:
            changes.append(f"remove {player.name} from your offer")
    for pick in a_picks:
        if pick not in base_a_picks:
            changes.append(f"add {pick.label} to your offer")
    for pick in base_a_picks:
        if pick not in a_picks:
            changes.append(f"remove {pick.label} from your offer")
    for player in b_players:
        if player not in base_b_players:
            changes.append(f"ask for {player.name}")
    for player in base_b_players:
        if player not in b_players:
            changes.append(f"remove {player.name} from the return")
    for pick in b_picks:
        if pick not in base_b_picks:
            changes.append(f"ask for {pick.label}")
    for pick in base_b_picks:
        if pick not in b_picks:
            changes.append(f"remove {pick.label} from the return")
    return "; ".join(changes) if changes else "Keep the original package"


def generate_counteroffers(
    team_a: Roster,
    team_b: Roster,
    a_players: list[Player],
    b_players: list[Player],
    league: League,
    a_picks: list[DraftPick] | None = None,
    b_picks: list[DraftPick] | None = None,
    contexts: dict[str, TeamContext] | None = None,
) -> list[Counteroffer]:
    base_ap, base_bp = tuple(a_players), tuple(b_players)
    base_ad, base_bd = tuple(a_picks or ()), tuple(b_picks or ())
    variants: set[tuple[tuple[Player, ...], tuple[DraftPick, ...], tuple[Player, ...], tuple[DraftPick, ...]]] = set()

    def add_variant(ap: tuple[Player, ...], ad: tuple[DraftPick, ...], bp: tuple[Player, ...], bd: tuple[DraftPick, ...]) -> None:
        if not (ap or ad) or not (bp or bd):
            return
        if base_bp or base_bd:
            requested = set(_side_key(base_bp, base_bd))
            if not requested.intersection(_side_key(bp, bd)):
                return
        variants.add((ap, ad, bp, bd))

    for player in base_ap:
        add_variant(tuple(item for item in base_ap if item != player), base_ad, base_bp, base_bd)
    for player in base_bp:
        add_variant(base_ap, base_ad, tuple(item for item in base_bp if item != player), base_bd)
    for pick in base_ad:
        add_variant(base_ap, tuple(item for item in base_ad if item != pick), base_bp, base_bd)
    for pick in base_bd:
        add_variant(base_ap, base_ad, base_bp, tuple(item for item in base_bd if item != pick))

    protected_a = protected_player_ids(team_a, league)
    a_pool = [player for player in team_a.players if player not in base_ap and player.id not in protected_a]
    b_pool = [player for player in team_b.players if player not in base_bp]
    target_value = abs(sum(player.value for player in base_bp) + sum(pick.value for pick in base_bd) - sum(player.value for player in base_ap) - sum(pick.value for pick in base_ad))
    a_pool = sorted(a_pool, key=lambda player: abs(player.value - target_value))[:8]
    b_pool = sorted(b_pool, key=lambda player: abs(player.value - target_value))[:8]
    for player in a_pool:
        add_variant(base_ap + (player,), base_ad, base_bp, base_bd)
    for player in b_pool:
        add_variant(base_ap, base_ad, base_bp + (player,), base_bd)
    for pick in team_a.draft_picks:
        if pick not in base_ad:
            add_variant(base_ap, base_ad + (pick,), base_bp, base_bd)
    for pick in team_b.draft_picks:
        if pick not in base_bd:
            add_variant(base_ap, base_ad, base_bp, base_bd + (pick,))
    for original in base_ap:
        for replacement in a_pool:
            add_variant(tuple(replacement if item == original else item for item in base_ap), base_ad, base_bp, base_bd)
    for original in base_bp:
        for replacement in b_pool:
            add_variant(base_ap, base_ad, tuple(replacement if item == original else item for item in base_bp), base_bd)

    evaluated: list[Counteroffer] = []
    for ap, ad, bp, bd in variants:
        result = evaluate_trade(team_a, team_b, list(ap), list(bp), league, list(ad), list(bd), contexts)
        edits = _edit_count(base_ap, base_ad, base_bp, base_bd, ap, ad, bp, bd)
        evaluated.append(Counteroffer("", _describe(base_ap, base_ad, base_bp, base_bd, ap, ad, bp, bd), ap, ad, bp, bd, result, edits))

    viable = [
        item for item in evaluated
        if abs(item.evaluation.fairness) <= 18
        and item.evaluation.lineup_a.points_gained >= -1
        and (item.evaluation.lineup_a.depth_change >= -12 or item.evaluation.lineup_a.points_gained >= 4)
        and (item.evaluation.lineup_a.playoff_points_gained is None or item.evaluation.lineup_a.playoff_points_gained >= -1 or item.evaluation.lineup_a.points_gained >= 5)
    ]
    if not viable:
        return []
    selections: list[Counteroffer] = []

    def select(label: str, candidates: list[Counteroffer], key: object) -> None:
        available = [item for item in candidates if all(_side_key(item.team_a_players, item.team_a_picks) != _side_key(chosen.team_a_players, chosen.team_a_picks) or _side_key(item.team_b_players, item.team_b_picks) != _side_key(chosen.team_b_players, chosen.team_b_picks) for chosen in selections)]
        if available:
            chosen = max(available, key=key)
            selections.append(Counteroffer(label, chosen.description, chosen.team_a_players, chosen.team_a_picks, chosen.team_b_players, chosen.team_b_picks, chosen.evaluation, chosen.edits))

    select("IDEAL", [item for item in viable if item.evaluation.acceptance_score >= 38], lambda item: (item.evaluation.lineup_a.points_gained * 4 + item.evaluation.fairness + item.evaluation.fit_a * .2, -item.edits))
    select("FAIR", viable, lambda item: (-abs(item.evaluation.fairness), item.evaluation.acceptance_score, -item.edits))
    select("FALLBACK", viable, lambda item: (item.evaluation.acceptance_score, -item.edits, item.evaluation.lineup_a.points_gained))
    return selections
