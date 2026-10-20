from __future__ import annotations

from typing import Any
from concurrent.futures import ThreadPoolExecutor

import requests
import streamlit as st

from .models import DraftPick, League, Player, Roster

SLEEPER_BASE = "https://api.sleeper.app/v1"
FANTASY_CALC_BASE = "https://api.fantasycalc.com/values/current"
TIMEOUT = 20


class ProviderError(RuntimeError):
    """A remote provider returned unusable data."""


def _get_json(url: str, *, params: dict[str, Any] | None = None) -> Any:
    try:
        response = requests.get(url, params=params, timeout=TIMEOUT)
        response.raise_for_status()
        return response.json()
    except (requests.RequestException, ValueError) as exc:
        raise ProviderError(f"Could not load data from {url.split('/')[2]}") from exc


@st.cache_data(ttl=300, show_spinner=False)
def get_user(username: str) -> dict[str, Any]:
    data = _get_json(f"{SLEEPER_BASE}/user/{username.strip()}")
    if not isinstance(data, dict) or not data.get("user_id"):
        raise ProviderError(f'Sleeper user "{username}" was not found')
    return data


@st.cache_data(ttl=300, show_spinner=False)
def get_nfl_state() -> dict[str, Any]:
    data = _get_json(f"{SLEEPER_BASE}/state/nfl")
    if not isinstance(data, dict) or not data.get("season"):
        raise ProviderError("Sleeper returned invalid NFL state")
    return data


@st.cache_data(ttl=300, show_spinner=False)
def get_leagues(user_id: str, season: str) -> list[dict[str, Any]]:
    data = _get_json(f"{SLEEPER_BASE}/user/{user_id}/leagues/nfl/{season}")
    if not isinstance(data, list):
        raise ProviderError("Sleeper returned an invalid league list")
    return [league for league in data if isinstance(league, dict) and league.get("league_id")]


@st.cache_data(ttl=3600, show_spinner=False)
def get_players() -> dict[str, dict[str, Any]]:
    data = _get_json(f"{SLEEPER_BASE}/players/nfl")
    if not isinstance(data, dict):
        raise ProviderError("Sleeper returned invalid player data")
    return data


@st.cache_data(ttl=86400, show_spinner=False)
def get_season_stats(season: str) -> dict[str, dict[str, float]]:
    def week(week_number: int) -> Any:
        try:
            return _get_json(f"{SLEEPER_BASE}/stats/nfl/regular/{season}/{week_number}")
        except ProviderError:
            return {}

    with ThreadPoolExecutor(max_workers=6) as pool:
        weeks = list(pool.map(week, range(1, 19)))
    totals: dict[str, dict[str, float]] = {}
    fields = ("tgt", "rec", "rec_yd", "rec_td", "rec_air_yd", "rec_yac", "rush_att", "rush_yd", "rush_td", "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int", "off_snp", "tm_off_snp", "rz_tgt", "rz_rush_att")
    for data in weeks:
        if not isinstance(data, dict):
            continue
        for player_id, raw in data.items():
            if not isinstance(raw, dict) or (float(raw.get("off_snp") or 0) == 0 and float(raw.get("pts_half_ppr") or 0) == 0):
                continue
            player = totals.setdefault(str(player_id), {"gp": 0.0, **{field: 0.0 for field in fields}})
            player["gp"] += 1
            for field in fields:
                player[field] += float(raw.get(field) or 0)
    return totals


@st.cache_data(ttl=3600, show_spinner=False)
def get_weekly_points(season: str, week: int, scoring: str) -> dict[str, float]:
    try:
        data = _get_json(f"https://api.sleeper.com/projections/nfl/{season}/{week}", params={"season_type": "regular"})
    except ProviderError:
        return {}
    if not isinstance(data, dict):
        return {}
    field = "pts_ppr" if scoring == "ppr" else "pts_half_ppr" if scoring == "half_ppr" else "pts_std"
    return {
        str(player_id): float(item.get("stats", {}).get(field) or 0)
        for player_id, item in data.items()
        if isinstance(item, dict) and isinstance(item.get("stats"), dict)
    }


@st.cache_data(ttl=3600, show_spinner=False)
def get_market_values(is_dynasty: bool, num_qbs: int, num_teams: int, ppr: float) -> dict[str, dict[str, int]]:
    data = _get_json(
        FANTASY_CALC_BASE,
        params={"isDynasty": str(is_dynasty).lower(), "numQbs": num_qbs, "numTeams": num_teams, "ppr": ppr},
    )
    if not isinstance(data, list):
        raise ProviderError("FantasyCalc returned invalid value data")
    values: dict[str, int] = {}
    picks: dict[str, int] = {}
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get("player"), dict):
            continue
        player = item["player"]
        sleeper_id = player.get("sleeperId")
        raw_value = item.get("value")
        name = str(player.get("name") or "")
        if player.get("position") == "PICK" and isinstance(raw_value, (int, float)):
            parts = name.split()
            if len(parts) == 2 and parts[0].isdigit() and parts[1] in {"1st", "2nd", "3rd", "4th"}:
                round_number = {"1st": 1, "2nd": 2, "3rd": 3, "4th": 4}[parts[1]]
                picks[f"{parts[0]}-{round_number}"] = round(raw_value / 100)
            continue
        if sleeper_id and isinstance(raw_value, (int, float)):
            values[str(sleeper_id)] = round(raw_value / 100)
    if not values:
        raise ProviderError("FantasyCalc returned no usable player values")
    return {"players": values, "picks": picks}


def _league_mode(league: dict[str, Any]) -> str:
    league_type = (league.get("settings") or {}).get("type")
    return "dynasty" if league_type == 2 else "keeper" if league_type == 1 else "redraft"


def _roster_slots(positions: list[str]) -> tuple[tuple[str, int], ...]:
    aliases = {"SUPER_FLEX": "SUPERFLEX", "REC_FLEX": "FLEX"}
    counts: dict[str, int] = {}
    for raw in positions:
        slot = aliases.get(raw, raw)
        if slot in {"QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "K", "DEF", "BN", "IR"}:
            counts[slot] = counts.get(slot, 0) + 1
    return tuple(counts.items())


def import_league(username: str, league_id: str) -> League:
    user = get_user(username)
    league = _get_json(f"{SLEEPER_BASE}/league/{league_id}")
    rosters_data = _get_json(f"{SLEEPER_BASE}/league/{league_id}/rosters")
    users_data = _get_json(f"{SLEEPER_BASE}/league/{league_id}/users")
    try:
        traded_picks = _get_json(f"{SLEEPER_BASE}/league/{league_id}/traded_picks")
    except ProviderError:
        traded_picks = []
    if not isinstance(league, dict) or not isinstance(rosters_data, list) or not isinstance(users_data, list):
        raise ProviderError("Sleeper returned incomplete league data")

    my_roster = next((r for r in rosters_data if r.get("owner_id") == user["user_id"]), None)
    if my_roster is None:
        raise ProviderError(f'{username} does not own a roster in this league')

    positions = league.get("roster_positions") or []
    superflex = "SUPER_FLEX" in positions or positions.count("QB") > 1
    scoring_settings = league.get("scoring_settings") or {}
    reception = float(scoring_settings.get("rec") or 0)
    te_premium = float(scoring_settings.get("bonus_rec_te") or 0) > 0 or float(scoring_settings.get("rec_te") or 0) > reception
    mode = _league_mode(league)
    team_count = int(league.get("total_rosters") or len(rosters_data))

    try:
        market = get_market_values(mode != "redraft", 2 if superflex else 1, team_count, reception)
        values = market["players"]
        pick_values = market["picks"]
        values_status = "live"
    except ProviderError:
        values = {}
        pick_values = {}
        values_status = "unavailable"

    player_data = get_players()
    players: dict[str, Player] = {}
    valid_positions = {"QB", "RB", "WR", "TE", "K", "DEF"}
    for roster in rosters_data:
        for player_id in roster.get("players") or []:
            raw = player_data.get(str(player_id), {})
            position = ((raw.get("fantasy_positions") or [raw.get("position")])[0])
            if position not in valid_positions:
                continue
            players[str(player_id)] = Player(
                id=str(player_id),
                name=(raw.get("full_name") or f'{raw.get("first_name", "")} {raw.get("last_name", "")}').strip() or "Unknown",
                position=position,
                team=raw.get("team") or "FA",
                age=int(raw.get("age") or 0),
                value=values.get(str(player_id), 0),
                injury_status=raw.get("injury_status"),
            )

    owners = {str(owner.get("user_id")): owner for owner in users_data if isinstance(owner, dict)}
    pick_owners: dict[tuple[int, int, str], str] = {}
    if isinstance(traded_picks, list):
        for traded in traded_picks:
            if not isinstance(traded, dict):
                continue
            try:
                key = (int(traded["season"]), int(traded["round"]), str(traded["roster_id"]))
                pick_owners[key] = str(traded["owner_id"])
            except (KeyError, TypeError, ValueError):
                continue
    try:
        base_year = int(league.get("season") or 0)
    except (TypeError, ValueError):
        base_year = 0
    future_years = range(base_year + 1, base_year + 4) if base_year else ()
    picks_by_roster: dict[str, list[DraftPick]] = {str(roster.get("roster_id")): [] for roster in rosters_data}
    if mode != "redraft":
        for year in future_years:
            for round_number in range(1, 4):
                for raw_roster in rosters_data:
                    original = str(raw_roster.get("roster_id"))
                    current = pick_owners.get((year, round_number, original), original)
                    fallback = 30 if round_number == 1 else 15 if round_number == 2 else 10
                    pick = DraftPick(year, round_number, original, current, pick_values.get(f"{year}-{round_number}", fallback))
                    if current in picks_by_roster:
                        picks_by_roster[current].append(pick)
    rosters: list[Roster] = []
    for raw_roster in rosters_data:
        owner = owners.get(str(raw_roster.get("owner_id")), {})
        metadata = owner.get("metadata") or {}
        team_name = metadata.get("team_name") or owner.get("display_name") or f'Team {raw_roster.get("roster_id")}'
        roster_players = tuple(players[player_id] for player_id in map(str, raw_roster.get("players") or []) if player_id in players)
        rosters.append(Roster(
            team_id=str(raw_roster.get("roster_id")),
            team_name=team_name,
            owner_name=owner.get("display_name") or owner.get("username") or "Unknown Manager",
            players=roster_players,
            draft_picks=tuple(sorted(picks_by_roster.get(str(raw_roster.get("roster_id")), []), key=lambda pick: (pick.year, pick.round, pick.original_owner))),
        ))

    scoring = "ppr" if reception >= 1 else "half_ppr" if reception >= 0.5 else "standard"
    state = get_nfl_state()
    stats = get_season_stats(str(state["season"]))
    weekly_points = get_weekly_points(str(state["season"]), int(state.get("week") or 1), scoring)
    return League(
        id=str(league["league_id"]), name=str(league.get("name") or "Sleeper League"),
        season=str(league.get("season") or ""), mode=mode, team_count=team_count,
        superflex=superflex, te_premium=te_premium, scoring=scoring,
        roster_slots=_roster_slots(positions),
        my_team_id=str(my_roster["roster_id"]), rosters=tuple(rosters), values_status=values_status,
        current_week=int(state.get("week") or 1), player_stats=stats, weekly_points=weekly_points,
    )
