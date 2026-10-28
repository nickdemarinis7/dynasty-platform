from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from .models import League


@dataclass(frozen=True)
class DiagnosticReport:
    level: str
    score: int
    metrics: tuple[tuple[str, str], ...]
    issues: tuple[str, ...]
    strengths: tuple[str, ...]


def build_diagnostic_report(league: League) -> DiagnosticReport:
    players = [player for roster in league.rosters for player in roster.players]
    player_ids = [player.id for player in players]
    unique_ids = set(player_ids)
    duplicate_ownership = len(player_ids) - len(unique_ids)
    valued = sum(player.value > 0 for player in players)
    stats = sum(player.id in league.player_stats for player in players)
    projected = sum(player.id in league.weekly_points for player in players)
    player_count = max(len(players), 1)
    value_coverage = valued / player_count
    stats_coverage = stats / player_count
    projection_coverage = projected / player_count
    age_hours: float | None = None
    if league.imported_at:
        try:
            imported = datetime.fromisoformat(league.imported_at.replace("Z", "+00:00"))
            age_hours = max(0.0, (datetime.now(timezone.utc) - imported.astimezone(timezone.utc)).total_seconds() / 3600)
        except ValueError:
            age_hours = None

    issues: list[str] = []
    strengths: list[str] = []
    score = 100
    if duplicate_ownership:
        issues.append(f"{duplicate_ownership} player ownership conflicts detected")
        score -= 30
    else:
        strengths.append("No duplicate player ownership detected")
    if value_coverage < .85:
        issues.append(f"Market values cover only {value_coverage:.0%} of rostered players")
        score -= 20
    else:
        strengths.append(f"Market-value coverage is {value_coverage:.0%}")
    if stats_coverage < .65:
        issues.append(f"Season production covers only {stats_coverage:.0%} of rostered players")
        score -= 15
    else:
        strengths.append(f"Season-production coverage is {stats_coverage:.0%}")
    if projection_coverage < .65:
        issues.append(f"Current-week projections cover only {projection_coverage:.0%} of rostered players")
        score -= 15
    else:
        strengths.append(f"Current-week projection coverage is {projection_coverage:.0%}")
    if not league.remaining_matchups and league.current_week <= league.regular_season_end:
        issues.append("Remaining matchup schedule is unavailable")
        score -= 8
    if not league.playoff_weekly_points:
        issues.append("Playoff-week projections are unavailable")
        score -= 5
    if not league.free_agents:
        issues.append("Unrostered player pool is unavailable")
        score -= 7
    if age_hours is not None and age_hours > 24:
        issues.append(f"League import is {age_hours:.0f} hours old")
        score -= 12
    elif age_hours is not None:
        strengths.append(f"League import is {age_hours:.1f} hours old")
    limited_sources = [source.source for source in league.source_health if source.level != "ready"]
    if limited_sources:
        issues.append("Limited sources: " + ", ".join(limited_sources))
        score -= min(15, len(limited_sources) * 3)
    score = max(0, min(100, score))
    level = "Healthy" if score >= 85 else "Usable with limits" if score >= 65 else "Needs attention"
    metrics = (
        ("Rostered players", str(len(players))),
        ("Market coverage", f"{value_coverage:.0%}"),
        ("Stats coverage", f"{stats_coverage:.0%}"),
        ("Projection coverage", f"{projection_coverage:.0%}"),
        ("Free agents", str(len(league.free_agents))),
        ("Remaining matchups", str(len(league.remaining_matchups))),
        ("Completed trades", str(round(sum(item.get("trades", 0) for item in league.manager_tendencies.values()) / 2))),
        ("Import duration", f"{league.import_duration_ms:,} ms" if league.import_duration_ms is not None else "—"),
    )
    return DiagnosticReport(level, score, metrics, tuple(dict.fromkeys(issues)), tuple(dict.fromkeys(strengths)))
