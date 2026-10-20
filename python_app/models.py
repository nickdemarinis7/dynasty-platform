from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Position = Literal["QB", "RB", "WR", "TE", "K", "DEF"]
LeagueMode = Literal["dynasty", "keeper", "redraft"]


@dataclass(frozen=True)
class Player:
    id: str
    name: str
    position: Position
    team: str
    age: int
    value: int
    injury_status: str | None = None


@dataclass(frozen=True)
class DraftPick:
    year: int
    round: int
    original_owner: str
    current_owner: str
    value: int

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

    @property
    def total_value(self) -> int:
        return sum(player.value for player in self.players)

    @property
    def starter_value(self) -> int:
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
