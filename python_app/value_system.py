from __future__ import annotations

from dataclasses import dataclass

from .models import DraftPick, League, Player, Roster


@dataclass(frozen=True)
class ValueProfile:
    value: float
    low: float
    high: float
    tier: str
    percentile: int
    source_count: int = 1
    source_disagreement: float = 0.0


@dataclass(frozen=True)
class PickProfile:
    adjusted_value: float
    low: float
    high: float
    projection: str
    confidence: str
    class_outlook: str = "Unknown class"
    class_multiplier: float = 1.0
    top_prospects: tuple[str, ...] = ()


@dataclass(frozen=True)
class DraftClassOutlook:
    year: int
    label: str
    multiplier: float
    confidence: str
    top_prospects: tuple[str, ...]
    prospect_count: int


def draft_class_outlooks(league: League) -> dict[int, DraftClassOutlook]:
    grouped: dict[int, list[tuple[float, str]]] = {}
    for prospect in league.devy_prospects:
        format_adjusted_value = prospect.value * (1.15 if league.superflex and prospect.position == "QB" else 1.0)
        grouped.setdefault(prospect.eligible_year, []).append((format_adjusted_value, prospect.name))
    scores: dict[int, float] = {}
    ordered_groups: dict[int, list[tuple[float, str]]] = {}
    for year, prospects in grouped.items():
        ordered = sorted(prospects, reverse=True)
        ordered_groups[year] = ordered
        values = [value for value, _ in ordered]
        if len(values) >= 3:
            top_one = values[0]
            top_three = sum(values[:3]) / min(3, len(values))
            top_twelve = sum(values[:12]) / min(12, len(values))
            scores[year] = top_one * .35 + top_three * .30 + top_twelve * .35
    if not scores:
        return {}
    baseline_values = sorted(scores.values())
    middle = len(baseline_values) // 2
    baseline = baseline_values[middle] if len(baseline_values) % 2 else sum(baseline_values[middle - 1:middle + 1]) / 2
    output: dict[int, DraftClassOutlook] = {}
    try:
        current_year = int(league.season)
    except (TypeError, ValueError):
        current_year = min(scores)
    for year, score in scores.items():
        ratio = score / max(baseline, 1)
        multiplier = max(.88, min(1.15, 1 + (ratio - 1) * .30))
        label = "Exceptional class" if multiplier >= 1.10 else "Strong class" if multiplier >= 1.04 else "Average class" if multiplier >= .97 else "Weak class" if multiplier >= .91 else "Very weak class"
        years_out = max(1, year - current_year)
        count = len(ordered_groups[year])
        confidence = "High" if years_out == 1 and count >= 12 else "Medium" if years_out <= 2 and count >= 8 else "Low"
        output[year] = DraftClassOutlook(year, label, round(multiplier, 3), confidence, tuple(name for _, name in ordered_groups[year][:3]), count)
    return output


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
    sources = list(league.market_source_values.get(player.id, {}).values())
    disagreement = (
        (max(sources) - min(sources)) / max(sum(sources) / len(sources), 1) * 100
        if len(sources) >= 2 else 0.0
    )
    return ValueProfile(
        player.value,
        round(max(0, player.value * (1 - uncertainty)), 1),
        round(player.value * (1 + uncertainty), 1),
        tier,
        rank,
        len(sources) or 1,
        round(disagreement, 1),
    )


def pick_profile(pick: DraftPick, league: League) -> PickProfile:
    """Estimate pick position from its original owner's current outlook.

    The provider value remains the neutral midpoint. Adjustments become more
    conservative and ranges wider as the pick moves farther into the future.
    """
    owner = next((roster for roster in league.rosters if roster.team_id == pick.original_owner), None)
    season_started = any(roster.games_played > 0 for roster in league.rosters)
    try:
        years_out = max(1, pick.year - int(league.season))
    except (TypeError, ValueError):
        years_out = 1
    if not owner or not season_started or len(league.rosters) < 3:
        projection, base_multiplier, confidence = "Uncertain", 1.0, "Low"
    else:
        ordered = sorted(
            league.rosters,
            key=lambda roster: (roster.win_percentage, roster.points_for, roster.potential_points),
            reverse=True,
        )
        owner_rank = next(index for index, roster in enumerate(ordered, 1) if roster.team_id == owner.team_id)
        percentile_finish = (owner_rank - 1) / max(len(ordered) - 1, 1)
        if percentile_finish < 1 / 3:
            projection, base_multiplier = "Projected late", .84
        elif percentile_finish >= 2 / 3:
            projection, base_multiplier = "Projected early", 1.18
        else:
            projection, base_multiplier = "Projected middle", 1.0
        confidence = "High" if years_out == 1 and owner.games_played >= 6 else "Medium" if years_out <= 2 else "Low"
    shrink = 1 / (1 + .35 * (years_out - 1))
    multiplier = 1 + (base_multiplier - 1) * shrink
    outlook = draft_class_outlooks(league).get(pick.year)
    if outlook:
        slot_exposure = .35 if projection == "Projected late" else .65 if projection == "Projected middle" else 1.0 if projection == "Projected early" else .50
        round_exposure = 1 / max(1, pick.round)
        distance_shrink = 1 / (1 + .20 * (years_out - 1))
        class_multiplier = 1 + (outlook.multiplier - 1) * slot_exposure * round_exposure * distance_shrink
        class_label = outlook.label
        top_prospects = outlook.top_prospects
    else:
        class_multiplier, class_label, top_prospects = 1.0, "Unknown class", ()
    adjusted = round(pick.value * multiplier * class_multiplier, 2)
    uncertainty = min(.38, .12 + .05 * (years_out - 1) + (.04 if projection == "Uncertain" else 0) + (.03 if not outlook or outlook.confidence == "Low" else 0))
    return PickProfile(
        adjusted,
        round(max(0, adjusted * (1 - uncertainty)), 1),
        round(adjusted * (1 + uncertainty), 1),
        projection,
        confidence,
        class_label,
        round(class_multiplier, 3),
        top_prospects,
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
