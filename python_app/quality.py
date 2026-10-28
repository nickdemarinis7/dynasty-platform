from __future__ import annotations

from dataclasses import dataclass

from .models import League


@dataclass(frozen=True)
class LeagueReadiness:
    level: str
    title: str
    issues: tuple[str, ...]
    strengths: tuple[str, ...]


def assess_league_readiness(league: League) -> LeagueReadiness:
    issues: list[str] = []
    strengths: list[str] = []
    statuses = {item.source: item for item in league.source_health}

    if league.values_status == "live":
        strengths.append("Current FantasyCalc market values loaded")
    else:
        issues.append("Market values are unavailable; trade analysis is disabled")

    stats_coverage = sum(player.id in league.player_stats for roster in league.rosters for player in roster.players)
    player_count = sum(len(roster.players) for roster in league.rosters)
    coverage = stats_coverage / max(player_count, 1)
    if coverage >= 0.7:
        strengths.append(f"Season production covers {coverage:.0%} of rostered players")
    else:
        issues.append(f"Season production covers only {coverage:.0%} of rostered players")

    if league.weekly_points:
        strengths.append("Current-week projections loaded")
    else:
        issues.append("Current-week projections are unavailable; lineup impact uses season scoring averages")

    limited_sources = [item.detail for item in statuses.values() if item.level != "ready"]
    issues.extend(detail for detail in limited_sources if detail not in issues)
    level = "ready" if not issues else "limited" if league.values_status == "live" and coverage >= 0.5 else "unavailable"
    title = "Decision-ready" if level == "ready" else "Use with context" if level == "limited" else "Analysis unavailable"
    return LeagueReadiness(level, title, tuple(dict.fromkeys(issues)), tuple(dict.fromkeys(strengths)))
