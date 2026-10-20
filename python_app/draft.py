from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .models import League
from .providers import ProviderError, SLEEPER_BASE, _get_json, get_market_values, get_players


@dataclass(frozen=True)
class DraftPlayer:
    id: str
    name: str
    position: str
    team: str
    age: int
    value: int
    need_score: int


@dataclass(frozen=True)
class DraftSnapshot:
    draft_id: str
    status: str
    draft_type: str
    season: str
    rounds: int
    teams: int
    total_picks: int
    picks_made: int
    current_pick: int | None
    on_clock_team: str | None
    on_clock_is_mine: bool
    my_next_pick: int | None
    picks_until_my_turn: int | None
    upcoming_picks: tuple[int, ...]
    available: tuple[DraftPlayer, ...]
    recent: tuple[dict[str, Any], ...]


def select_relevant_draft(drafts: list[dict[str, Any]], season: str) -> dict[str, Any] | None:
    if not drafts:
        return None
    matching = [draft for draft in drafts if str(draft.get("season")) == season]
    candidates = matching or drafts
    priority = {"drafting": 0, "pre_draft": 1, "complete": 2}
    return sorted(candidates, key=lambda draft: (-int(draft.get("season") or 0), priority.get(str(draft.get("status")), 3), -int(draft.get("start_time") or 0), str(draft.get("draft_id"))))[0]


def build_pick_order(draft: dict[str, Any]) -> list[int]:
    settings = draft.get("settings") or {}
    teams, rounds = int(settings.get("teams") or 0), int(settings.get("rounds") or 0)
    mapping = draft.get("slot_to_roster_id") or {}
    if teams < 1 or rounds < 1:
        raise ProviderError("Sleeper draft has invalid team or round settings")
    order: list[int] = []
    for round_number in range(1, rounds + 1):
        slots = list(range(1, teams + 1))
        if draft.get("type") == "snake" and round_number % 2 == 0:
            slots.reverse()
        for slot in slots:
            roster_id = mapping.get(str(slot))
            if not isinstance(roster_id, int):
                raise ProviderError(f"Sleeper draft is missing the roster for slot {slot}")
            order.append(roster_id)
    return order


def load_draft_snapshot(league: League) -> DraftSnapshot:
    drafts = _get_json(f"{SLEEPER_BASE}/league/{league.id}/drafts")
    if not isinstance(drafts, list):
        raise ProviderError("Sleeper returned invalid draft data")
    selected = select_relevant_draft(drafts, league.season)
    if not selected:
        raise ProviderError("No draft was found for this league")
    draft_id = str(selected["draft_id"])
    draft = _get_json(f"{SLEEPER_BASE}/draft/{draft_id}")
    picks = _get_json(f"{SLEEPER_BASE}/draft/{draft_id}/picks")
    traded = _get_json(f"{SLEEPER_BASE}/league/{league.id}/traded_picks")
    if not isinstance(draft, dict) or not isinstance(picks, list) or not isinstance(traded, list):
        raise ProviderError("Sleeper returned incomplete draft data")

    order = build_pick_order(draft)
    teams = int((draft.get("settings") or {}).get("teams") or league.team_count)
    rounds = int((draft.get("settings") or {}).get("rounds") or 0)
    season = str(draft.get("season") or league.season)
    ownership: dict[tuple[int, int], int] = {}
    for item in traded:
        if isinstance(item, dict) and str(item.get("season")) == season:
            try:
                ownership[(int(item["roster_id"]), int(item["round"]))] = int(item["owner_id"])
            except (KeyError, TypeError, ValueError):
                continue

    def owner_of(pick_number: int) -> int:
        original = order[pick_number - 1]
        round_number = (pick_number - 1) // teams + 1
        return ownership.get((original, round_number), original)

    picks_made = len(picks)
    complete = draft.get("status") == "complete" or picks_made >= len(order)
    current = None if complete else picks_made + 1
    my_id = int(league.my_team_id)
    upcoming = tuple(number for number in range(picks_made + 1, len(order) + 1) if owner_of(number) == my_id)
    on_clock_id = owner_of(current) if current else None
    names = {int(roster.team_id): roster.team_name for roster in league.rosters}

    drafted_ids = {str(pick.get("player_id")) for pick in picks if isinstance(pick, dict)}
    market = get_market_values(league.mode != "redraft", 2 if league.superflex else 1, league.team_count, 1 if league.scoring == "ppr" else .5 if league.scoring == "half_ppr" else 0)
    values = market["players"]
    all_players = get_players()
    my_roster = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    counts = {position: sum(player.position == position for player in my_roster.players) for position in ("QB", "RB", "WR", "TE")}
    for pick in picks:
        if isinstance(pick, dict) and int(pick.get("roster_id") or -1) == my_id:
            position = str((pick.get("metadata") or {}).get("position") or "")
            if position in counts:
                counts[position] += 1
    targets = {"QB": 3 if league.superflex else 2, "RB": 6, "WR": 7, "TE": 3}
    available: list[DraftPlayer] = []
    for player_id, raw in all_players.items():
        if player_id in drafted_ids or not isinstance(raw, dict) or raw.get("years_exp") != 0:
            continue
        position = str(raw.get("position") or "")
        value = values.get(str(player_id), 0)
        if position not in targets or value <= 0:
            continue
        need = max(0, targets[position] - counts[position])
        available.append(DraftPlayer(str(player_id), str(raw.get("full_name") or f'{raw.get("first_name", "")} {raw.get("last_name", "")}').strip(), position, str(raw.get("team") or "FA"), int(raw.get("age") or 0), value, need))
    available.sort(key=lambda player: (player.value + player.need_score * 2, player.value), reverse=True)

    recent: list[dict[str, Any]] = []
    for pick in sorted((item for item in picks if isinstance(item, dict)), key=lambda item: int(item.get("pick_no") or 0), reverse=True)[:12]:
        metadata = pick.get("metadata") or {}
        roster_id = int(pick.get("roster_id") or 0)
        recent.append({"pick_no": int(pick.get("pick_no") or 0), "round": int(pick.get("round") or 0), "slot": int(pick.get("draft_slot") or 0), "name": f'{metadata.get("first_name", "")} {metadata.get("last_name", "")}'.strip(), "position": metadata.get("position") or "", "team_name": names.get(roster_id, f"Team {roster_id}"), "is_mine": roster_id == my_id})

    next_pick = upcoming[0] if upcoming else None
    return DraftSnapshot(draft_id, str(draft.get("status") or "unknown"), str(draft.get("type") or "linear"), season, rounds, teams, len(order), picks_made, current, names.get(on_clock_id) if on_clock_id else None, on_clock_id == my_id, next_pick, next_pick - current if next_pick and current else None, upcoming, tuple(available[:60]), tuple(recent))
