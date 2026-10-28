from __future__ import annotations

from collections.abc import Mapping


DEFAULT_SCORING: dict[str, float] = {
    "pass_yd": 0.04,
    "pass_td": 4.0,
    "pass_int": -2.0,
    "pass_2pt": 2.0,
    "rush_yd": 0.1,
    "rush_td": 6.0,
    "rush_2pt": 2.0,
    "rec": 0.5,
    "rec_yd": 0.1,
    "rec_td": 6.0,
    "rec_2pt": 2.0,
    "fum_lost": -2.0,
}


def score_stats(
    stats: Mapping[str, float],
    scoring: Mapping[str, float],
    position: str,
) -> float:
    """Score a stat line with the league's Sleeper scoring contract.

    Sleeper uses matching names for most scoring and stat fields. Explicitly
    supported bonuses are additive; unknown settings are preserved on League
    for transparency instead of being silently approximated here.
    """
    rules = {**DEFAULT_SCORING, **scoring}
    total = sum(float(stats.get(field, 0) or 0) * points for field, points in rules.items() if field in stats)
    if position == "TE":
        receptions = float(stats.get("rec", 0) or 0)
        total += receptions * float(scoring.get("bonus_rec_te", 0) or 0)
        if "rec_te" in scoring:
            total += receptions * max(0.0, float(scoring["rec_te"]) - float(scoring.get("rec", rules["rec"])))
    return total


def unsupported_scoring_settings(scoring: Mapping[str, float]) -> tuple[str, ...]:
    """Return enabled threshold bonuses that need explicit event handling."""
    return tuple(sorted(
        key for key, value in scoring.items()
        if key.startswith("bonus_") and key != "bonus_rec_te" and float(value or 0) != 0
    ))
