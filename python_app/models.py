from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Position = Literal["QB", "RB", "WR", "TE", "K", "DEF"]
LeagueMode = Literal["dynasty", "keeper", "redraft"]
HealthLevel = Literal["ready", "limited", "unavailable"]


@dataclass(frozen=True)
class SourceHealth:
    source: str
    level: HealthLevel
    detail: str
    observed_at: str | None = None


@dataclass(frozen=True)
class Player:
    id: str
    name: str
    position: Position
    team: str
    age: int
    value: float
    injury_status: str | None = None


@dataclass(frozen=True)
class DraftPick:
    year: int
    round: int
    original_owner: str
    current_owner: str
    value: float

    @property
    def label(self) -> str:
        suffix = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th"}.get(self.round, f"R{self.round}")
        return f"{self.year} {suffix}"


@dataclass(frozen=True)
class Roster:
    team_id: str
    team_name: str
    owner_name: str
    players: tuple[Player, ...] = field(default_factory=tuple)
    draft_picks: tuple[DraftPick, ...] = field(default_factory=tuple)
    wins: int = 0
    losses: int = 0
    ties: int = 0
    points_for: float = 0.0
    potential_points: float = 0.0
    reserve_player_ids: tuple[str, ...] = field(default_factory=tuple)
    taxi_player_ids: tuple[str, ...] = field(default_factory=tuple)
    waiver_budget_remaining: int | None = None
    waiver_position: int | None = None

    @property
    def games_played(self) -> int:
        return self.wins + self.losses + self.ties

    @property
    def win_percentage(self) -> float:
        return (self.wins + self.ties * 0.5) / self.games_played if self.games_played else 0.0

    @property
    def record(self) -> str:
        return f"{self.wins}-{self.losses}" + (f"-{self.ties}" if self.ties else "")

    @property
    def player_value(self) -> float:
        return sum(player.value for player in self.players)

    @property
    def pick_value(self) -> float:
        return sum(pick.value for pick in self.draft_picks)

    @property
    def total_asset_value(self) -> float:
        return self.player_value + self.pick_value

    @property
    def total_value(self) -> float:
        """Backward-compatible player-only value; prefer the explicit properties."""
        return self.player_value

    @property
    def starter_value(self) -> float:
        return sum(sorted((player.value for player in self.players), reverse=True)[:10])

    @property
    def average_age(self) -> float:
        ages = [player.age for player in self.players if player.age > 0]
        return sum(ages) / len(ages) if ages else 0.0


@dataclass(frozen=True)
class League:
    id: str
    name: str
    season: str
    mode: LeagueMode
    team_count: int
    superflex: bool
    te_premium: bool
    scoring: Literal["ppr", "half_ppr", "standard"]
    roster_slots: tuple[tuple[str, int], ...]
    my_team_id: str
    rosters: tuple[Roster, ...]
    values_status: Literal["live", "unavailable"]
    current_week: int = 1
    player_stats: dict[str, dict[str, float]] = field(default_factory=dict)
    weekly_points: dict[str, float] = field(default_factory=dict)
    scoring_settings: dict[str, float] = field(default_factory=dict)
    player_teams: dict[str, str] = field(default_factory=dict)
    source_health: tuple[SourceHealth, ...] = field(default_factory=tuple)
    imported_at: str | None = None
    playoff_teams: int = 6
    regular_season_end: int = 14
    remaining_matchups: tuple[tuple[int, str, str], ...] = field(default_factory=tuple)
    trade_deadline_week: int | None = None
    playoff_weekly_points: dict[int, dict[str, float]] = field(default_factory=dict)
    manager_tendencies: dict[str, dict[str, float]] = field(default_factory=dict)
    free_agents: tuple[Player, ...] = field(default_factory=tuple)
    active_roster_capacity: int = 0
    waiver_budget: int | None = None
    import_duration_ms: int | None = None
