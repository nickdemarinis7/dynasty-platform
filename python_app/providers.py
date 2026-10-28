from __future__ import annotations

from typing import Any
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from time import monotonic

import requests
import streamlit as st

from .models import DraftPick, League, Player, Roster, SourceHealth
from .scoring import score_stats, unsupported_scoring_settings

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
def get_season_stats_snapshot(season: str, through_week: int) -> tuple[dict[str, dict[str, float]], tuple[int, ...]]:
    def week(week_number: int) -> tuple[int, Any]:
        try:
            return week_number, _get_json(f"{SLEEPER_BASE}/stats/nfl/regular/{season}/{week_number}")
        except ProviderError:
            return week_number, None

    with ThreadPoolExecutor(max_workers=6) as pool:
        weeks = list(pool.map(week, range(1, max(1, min(18, through_week)) + 1)))
    totals: dict[str, dict[str, float]] = {}
    successful: list[int] = []
    fields = ("tgt", "rec", "rec_yd", "rec_td", "rec_2pt", "rec_air_yd", "rec_yac", "rush_att", "rush_yd", "rush_td", "rush_2pt", "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int", "pass_2pt", "fum_lost", "off_snp", "tm_off_snp", "rz_tgt", "rz_rush_att")
    for week_number, data in weeks:
        if not isinstance(data, dict):
            continue
        successful.append(week_number)
        for player_id, raw in data.items():
            if not isinstance(raw, dict) or (float(raw.get("off_snp") or 0) == 0 and float(raw.get("pts_half_ppr") or 0) == 0):
                continue
            player = totals.setdefault(str(player_id), {"gp": 0.0, **{field: 0.0 for field in fields}})
            player["gp"] += 1
            for field in fields:
                player[field] += float(raw.get(field) or 0)
    return totals, tuple(successful)


def get_season_stats(season: str) -> dict[str, dict[str, float]]:
    return get_season_stats_snapshot(season, 18)[0]


@st.cache_data(ttl=3600, show_spinner=False)
def get_weekly_projection_stats(season: str, week: int) -> dict[str, dict[str, float]]:
    try:
        data = _get_json(f"https://api.sleeper.com/projections/nfl/{season}/{week}", params={"season_type": "regular"})
    except ProviderError:
        return {}
    return _parse_weekly_projection_stats(data)


def _parse_weekly_projection_stats(data: Any) -> dict[str, dict[str, float]]:
    """Normalize both Sleeper projection response shapes.

    The projections service currently returns a list with ``player_id`` on
    each row, while older responses and some mirrors use a player-id mapping.
    """
    if isinstance(data, list):
        rows = (
            (str(item.get("player_id")), item)
            for item in data
            if isinstance(item, dict) and item.get("player_id") is not None
        )
    elif isinstance(data, dict):
        rows = ((str(player_id), item) for player_id, item in data.items())
    else:
        return {}
    return {
        player_id: {
            str(key): float(value or 0)
            for key, value in item.get("stats", {}).items()
            if isinstance(value, (int, float))
        }
        for player_id, item in rows
        if isinstance(item, dict) and isinstance(item.get("stats"), dict)
    }


def get_weekly_points(season: str, week: int, scoring: str) -> dict[str, float]:
    reception = 1.0 if scoring == "ppr" else 0.5 if scoring == "half_ppr" else 0.0
    return {player_id: score_stats(stats, {"rec": reception}, "") for player_id, stats in get_weekly_projection_stats(season, week).items()}


@st.cache_data(ttl=3600, show_spinner=False)
def get_market_values(is_dynasty: bool, num_qbs: int, num_teams: int, ppr: float) -> dict[str, dict[str, float]]:
    data = _get_json(
        FANTASY_CALC_BASE,
        params={"isDynasty": str(is_dynasty).lower(), "numQbs": num_qbs, "numTeams": num_teams, "ppr": ppr},
    )
    if not isinstance(data, list):
        raise ProviderError("FantasyCalc returned invalid value data")
    values: dict[str, float] = {}
    picks: dict[str, float] = {}
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
                picks[f"{parts[0]}-{round_number}"] = round(raw_value / 100, 2)
            continue
        if sleeper_id and isinstance(raw_value, (int, float)):
            values[str(sleeper_id)] = round(raw_value / 100, 2)
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


def _roster_points(settings: dict[str, Any], key: str) -> float:
    """Combine Sleeper's whole and two-digit decimal scoring fields."""
    return round(float(settings.get(key) or 0) + float(settings.get(f"{key}_decimal") or 0) / 100, 2)


@st.cache_data(ttl=3600, show_spinner=False)
def get_remaining_matchups(league_id: str, first_week: int, last_week: int) -> tuple[tuple[int, str, str], ...]:
    def load(week: int) -> tuple[int, Any]:
        try:
            return week, _get_json(f"{SLEEPER_BASE}/league/{league_id}/matchups/{week}")
        except ProviderError:
            return week, None

    if first_week > last_week:
        return ()
    with ThreadPoolExecutor(max_workers=6) as pool:
        weeks = list(pool.map(load, range(first_week, last_week + 1)))
    schedule: list[tuple[int, str, str]] = []
    for week, rows in weeks:
        if not isinstance(rows, list):
            continue
        groups: dict[str, list[str]] = {}
        for row in rows:
            if not isinstance(row, dict) or row.get("matchup_id") is None or row.get("roster_id") is None:
                continue
            groups.setdefault(str(row["matchup_id"]), []).append(str(row["roster_id"]))
        for teams in groups.values():
            if len(teams) == 2:
                schedule.append((week, teams[0], teams[1]))
    return tuple(schedule)


@st.cache_data(ttl=3600, show_spinner=False)
def get_league_transactions(league_id: str, through_week: int) -> tuple[dict[str, Any], ...]:
    def load(week: int) -> Any:
        try:
            return _get_json(f"{SLEEPER_BASE}/league/{league_id}/transactions/{week}")
        except ProviderError:
            return None

    with ThreadPoolExecutor(max_workers=6) as pool:
        weeks = list(pool.map(load, range(1, max(1, through_week) + 1)))
    return tuple(
        transaction
        for rows in weeks if isinstance(rows, list)
        for transaction in rows
        if isinstance(transaction, dict) and transaction.get("type") == "trade" and transaction.get("status") == "complete"
    )


def import_league(username: str, league_id: str) -> League:
    import_started = monotonic()
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

    league_settings = league.get("settings") or {}
    positions = league.get("roster_positions") or []
    superflex = "SUPER_FLEX" in positions or positions.count("QB") > 1
    scoring_settings = {
        str(key): float(value)
        for key, value in (league.get("scoring_settings") or {}).items()
        if isinstance(value, (int, float))
    }
    reception = float(scoring_settings.get("rec") or 0)
    te_premium = float(scoring_settings.get("bonus_rec_te") or 0) > 0 or float(scoring_settings.get("rec_te") or 0) > reception
    mode = _league_mode(league)
    team_count = int(league.get("total_rosters") or len(rosters_data))
    raw_waiver_budget = int(league_settings.get("waiver_budget") or 0)
    waiver_budget = raw_waiver_budget if raw_waiver_budget > 0 else None

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
    player_teams = {
        str(player_id): str(raw.get("team"))
        for player_id, raw in player_data.items()
        if isinstance(raw, dict) and raw.get("team")
    }
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

    rostered_ids = set(players)
    free_agents: list[Player] = []
    for player_id, value in values.items():
        if player_id in rostered_ids or value <= 0:
            continue
        raw = player_data.get(player_id, {})
        position = ((raw.get("fantasy_positions") or [raw.get("position")])[0])
        if position not in valid_positions or not raw.get("team"):
            continue
        free_agents.append(Player(
            id=player_id,
            name=(raw.get("full_name") or f'{raw.get("first_name", "")} {raw.get("last_name", "")}').strip() or "Unknown",
            position=position,
            team=raw.get("team") or "FA",
            age=int(raw.get("age") or 0),
            value=value,
            injury_status=raw.get("injury_status"),
        ))
    free_agents = sorted(free_agents, key=lambda player: player.value, reverse=True)[:300]

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
    draft_rounds = max(1, int((league.get("settings") or {}).get("draft_rounds") or 3))
    future_years = range(base_year + 1, base_year + 4) if base_year else ()
    picks_by_roster: dict[str, list[DraftPick]] = {str(roster.get("roster_id")): [] for roster in rosters_data}
    if mode != "redraft":
        for year in future_years:
            for round_number in range(1, draft_rounds + 1):
                for raw_roster in rosters_data:
                    original = str(raw_roster.get("roster_id"))
                    current = pick_owners.get((year, round_number, original), original)
                    pick = DraftPick(year, round_number, original, current, pick_values.get(f"{year}-{round_number}", 0))
                    if current in picks_by_roster:
                        picks_by_roster[current].append(pick)
    rosters: list[Roster] = []
    for raw_roster in rosters_data:
        owner = owners.get(str(raw_roster.get("owner_id")), {})
        metadata = owner.get("metadata") or {}
        team_name = metadata.get("team_name") or owner.get("display_name") or f'Team {raw_roster.get("roster_id")}'
        roster_players = tuple(players[player_id] for player_id in map(str, raw_roster.get("players") or []) if player_id in players)
        roster_settings = raw_roster.get("settings") or {}
        rosters.append(Roster(
            team_id=str(raw_roster.get("roster_id")),
            team_name=team_name,
            owner_name=owner.get("display_name") or owner.get("username") or "Unknown Manager",
            players=roster_players,
            draft_picks=tuple(sorted(picks_by_roster.get(str(raw_roster.get("roster_id")), []), key=lambda pick: (pick.year, pick.round, pick.original_owner))),
            wins=int(roster_settings.get("wins") or 0),
            losses=int(roster_settings.get("losses") or 0),
            ties=int(roster_settings.get("ties") or 0),
            points_for=_roster_points(roster_settings, "fpts"),
            potential_points=_roster_points(roster_settings, "ppts"),
            reserve_player_ids=tuple(map(str, raw_roster.get("reserve") or [])),
            taxi_player_ids=tuple(map(str, raw_roster.get("taxi") or [])),
            waiver_budget_remaining=max(0, waiver_budget - int(roster_settings.get("waiver_budget_used") or 0)) if waiver_budget is not None else None,
            waiver_position=int(roster_settings.get("waiver_position") or 0) or None,
        ))

    scoring = "ppr" if reception >= 1 else "half_ppr" if reception >= 0.5 else "standard"
    state = get_nfl_state()
    current_week = int(state.get("week") or 1)
    transactions = get_league_transactions(str(league_id), current_week)
    manager_tendencies: dict[str, dict[str, float]] = {str(roster.get("roster_id")): {"trades": 0.0, "picks_acquired": 0.0} for roster in rosters_data}
    for transaction in transactions:
        for roster_id in transaction.get("roster_ids") or []:
            tendency = manager_tendencies.setdefault(str(roster_id), {"trades": 0.0, "picks_acquired": 0.0})
            tendency["trades"] += 1
        for player_id, roster_id in (transaction.get("adds") or {}).items():
            position = str(player_data.get(str(player_id), {}).get("position") or "")
            if position in {"QB", "RB", "WR", "TE"}:
                tendency = manager_tendencies.setdefault(str(roster_id), {"trades": 0.0, "picks_acquired": 0.0})
                tendency[f"{position.lower()}_acquired"] = tendency.get(f"{position.lower()}_acquired", 0.0) + 1
        for pick in transaction.get("draft_picks") or []:
            if isinstance(pick, dict) and pick.get("owner_id") is not None:
                tendency = manager_tendencies.setdefault(str(pick["owner_id"]), {"trades": 0.0, "picks_acquired": 0.0})
                tendency["picks_acquired"] += 1
    playoff_week_start = int(league_settings.get("playoff_week_start") or 15)
    regular_season_end = max(1, playoff_week_start - 1)
    playoff_teams = max(1, min(team_count, int(league_settings.get("playoff_teams") or min(6, team_count))))
    raw_deadline = int(league_settings.get("trade_deadline") or 0)
    trade_deadline_week = raw_deadline if 1 <= raw_deadline <= 18 else None
    remaining_matchups = get_remaining_matchups(str(league_id), current_week, regular_season_end)
    stats, stats_weeks = get_season_stats_snapshot(str(state["season"]), max(1, current_week - 1))
    weekly_stats = get_weekly_projection_stats(str(state["season"]), current_week)
    weekly_points = {
        player_id: round(score_stats(raw, scoring_settings, str(player_data.get(player_id, {}).get("position") or "")), 2)
        for player_id, raw in weekly_stats.items()
    }
    playoff_weeks = range(playoff_week_start, min(17, playoff_week_start + 2) + 1)
    playoff_weekly_points: dict[int, dict[str, float]] = {}
    for week in playoff_weeks:
        projected = get_weekly_projection_stats(str(state["season"]), week)
        scored = {
            player_id: round(score_stats(raw, scoring_settings, str(player_data.get(player_id, {}).get("position") or "")), 2)
            for player_id, raw in projected.items()
        }
        if scored:
            playoff_weekly_points[week] = scored
    expected_weeks = max(0, min(18, current_week - 1))
    unsupported_scoring = unsupported_scoring_settings(scoring_settings)
    standings_available = any(roster.games_played for roster in rosters)
    health = (
        SourceHealth("Sleeper league", "ready", "League, roster, and ownership data loaded", datetime.now(timezone.utc).isoformat()),
        SourceHealth("Sleeper standings", "ready" if standings_available else "limited", "Current records and points scored loaded" if standings_available else "No completed games yet; direction uses roster evidence"),
        SourceHealth("Sleeper schedule", "ready" if remaining_matchups or current_week > regular_season_end else "limited", f"Loaded {len(remaining_matchups)} remaining matchups" if remaining_matchups else "Remaining schedule unavailable"),
        SourceHealth("Trade history", "ready" if transactions else "limited", f"Loaded {len(transactions)} completed league trades" if transactions else "No completed trades found this season"),
        SourceHealth("FantasyCalc", "ready" if values_status == "live" else "unavailable", "Current market values loaded" if values_status == "live" else "Market values could not be loaded", datetime.now(timezone.utc).isoformat()),
        SourceHealth("Sleeper stats", "ready" if len(stats_weeks) == expected_weeks else "limited", f"Loaded {len(stats_weeks)} of {expected_weeks} completed weeks"),
        SourceHealth("Sleeper projections", "ready" if weekly_points else "limited", f"Week {current_week} projections loaded" if weekly_points else f"Week {current_week} projections unavailable"),
        SourceHealth("Playoff projections", "ready" if playoff_weekly_points else "limited", f"Loaded weeks {', '.join(map(str, playoff_weekly_points))}" if playoff_weekly_points else "Future playoff-week projections are not yet available"),
        SourceHealth("Draft picks", "ready" if mode == "redraft" or bool(pick_values) else "limited", "Market pick values loaded" if pick_values else "Unpriced picks are retained with no estimated value"),
        SourceHealth("League scoring", "limited" if unsupported_scoring else "ready", f"{len(unsupported_scoring)} threshold bonus rules are disclosed but not modeled" if unsupported_scoring else "Imported scoring rules are supported"),
    )
    return League(
        id=str(league["league_id"]), name=str(league.get("name") or "Sleeper League"),
        season=str(league.get("season") or ""), mode=mode, team_count=team_count,
        superflex=superflex, te_premium=te_premium, scoring=scoring,
        roster_slots=_roster_slots(positions),
        my_team_id=str(my_roster["roster_id"]), rosters=tuple(rosters), values_status=values_status,
        current_week=current_week, player_stats=stats, weekly_points=weekly_points,
        scoring_settings=scoring_settings, player_teams=player_teams, source_health=health,
        imported_at=datetime.now(timezone.utc).isoformat(),
        playoff_teams=playoff_teams, regular_season_end=regular_season_end,
        remaining_matchups=remaining_matchups,
        trade_deadline_week=trade_deadline_week,
        playoff_weekly_points=playoff_weekly_points,
        manager_tendencies=manager_tendencies,
        free_agents=tuple(free_agents),
        active_roster_capacity=sum(count for slot, count in _roster_slots(positions) if slot not in {"IR"}),
        waiver_budget=waiver_budget,
        import_duration_ms=round((monotonic() - import_started) * 1000),
    )
