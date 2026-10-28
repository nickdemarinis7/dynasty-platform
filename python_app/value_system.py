from __future__ import annotations

from dataclasses import dataclass

from .models import League, Player, Roster


@dataclass(frozen=True)
class ValueProfile:
    value: float
    low: float
    high: float
    tier: str
    percentile: int


def _league_values(league: League) -> list[float]:
    return sorted(
        (player.value for roster in league.rosters for player in roster.players if player.value > 0),
    )


def percentile(value: float, values: list[float]) -> int:
    if not values:
        return 0
    below = sum(item < value for item in values)
    equal = sum(item == value for item in values)
    return round((below + max(0, equal - 1) / 2) / max(len(values) - 1, 1) * 100)


def value_profile(player: Player, league: League) -> ValueProfile:
    rank = percentile(player.value, _league_values(league))
    if rank >= 98:
        tier = "Cornerstone"
    elif rank >= 90:
        tier = "Premium asset"
    elif rank >= 70:
        tier = "Core asset"
    elif rank >= 40:
        tier = "Supporting asset"
    else:
        tier = "Marginal asset"
    # A continuous curve avoids artificial range jumps when two adjacent
    # players happen to fall on opposite sides of a tier label.
    uncertainty = .08 + (100 - rank) / 100 * .20
    return ValueProfile(
        player.value,
        round(max(0, player.value * (1 - uncertainty)), 1),
        round(player.value * (1 + uncertainty), 1),
        tier,
        rank,
    )


def protected_player_ids(roster: Roster, league: League) -> set[str]:
    """Protect relative cornerstones; never depend on a provider-specific scale."""
    valued = sorted((player for player in roster.players if player.value > 0), key=lambda item: item.value, reverse=True)
    if not valued:
        return set()
    maximum = valued[0].value
    league_values = _league_values(league)
    protected = {
        player.id
        for player in valued
        if player.value >= maximum * .72 or percentile(player.value, league_values) >= 94
    }
    if league.superflex:
        protected.update(
            player.id for player in valued
            if player.position == "QB" and player.age <= 27
            and (player.value >= maximum * .52 or percentile(player.value, league_values) >= 85)
        )
    return protected


def premium_value_cutoff(league: League, minimum_percentile: float = .90) -> float:
    values = _league_values(league)
    if not values:
        return 0
    index = min(len(values) - 1, max(0, round((len(values) - 1) * minimum_percentile)))
    return values[index]


def balance_label(fairness: float) -> str:
    magnitude = abs(fairness)
    if magnitude <= 5:
        return "Roughly even"
    direction = "Receive" if fairness > 0 else "Give"
    if magnitude <= 12:
        return f"{direction} a little more"
    if magnitude <= 20:
        return f"{direction} meaningfully more"
    return f"{direction} substantially more"


def format_value(value: float) -> str:
    return f"{value:.1f}".rstrip("0").rstrip(".")
