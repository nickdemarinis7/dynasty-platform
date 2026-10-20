from __future__ import annotations

from dataclasses import dataclass

from .models import DraftPick, League, Player, Roster


@dataclass(frozen=True)
class Lineup:
    starters: tuple[Player, ...]
    bench: tuple[Player, ...]
    projected_points: float


@dataclass(frozen=True)
class LineupImpact:
    before_points: float
    after_points: float
    points_gained: float
    received_player_starts: bool
    recommendation: str


@dataclass(frozen=True)
class TradeResult:
    team_a_gives: float
    team_b_gives: float
    difference_for_a: float
    fairness: float
    lineup_a: LineupImpact
    lineup_b: LineupImpact
    verdict: str
    fit_a: float
    fit_b: float
    acceptance_score: int


@dataclass(frozen=True)
class TeamContext:
    roster: Roster
    league_rank: int
    average_age: float
    win_now_weight: float
    window: str
    position_needs: dict[str, float]


@dataclass(frozen=True)
class PlayerProjection:
    player: Player
    fppg: float | None
    production_score: int
    role_score: int
    trajectory: str
    edge_score: int
    edge_delta: int
    recommendation: str
    signals: tuple[str, ...]


def projected_points(player: Player, league: League) -> float:
    weekly = league.weekly_points.get(player.id)
    if weekly is not None and weekly > 0:
        return round(weekly, 1)
    stats = league.player_stats.get(player.id)
    if stats and stats.get("gp", 0) > 0:
        return round(calc_fppg(stats, player, league), 1)
    if player.value <= 0:
        return 0.0
    discount = 1.0 if league.mode == "redraft" else (0.70 if player.age <= 22 else 0.85 if player.age <= 24 else 1.0 if player.age <= 27 else 1.05 if player.age <= 30 else 0.90)
    adjusted = player.value * discount
    base = {
        "QB": 10 + adjusted / 100 * 16,
        "RB": 6 + adjusted / 100 * 14,
        "WR": 5 + adjusted / 100 * 13,
        "TE": 4 + adjusted / 100 * 10,
    }.get(player.position, adjusted / 10)
    status = (player.injury_status or "active").lower()
    if status in {"out", "o", "ir", "pup", "nfi", "suspended", "sus"}:
        base = 0
    elif status in {"doubtful", "d"}:
        base *= 0.3
    elif status in {"questionable", "q"}:
        base *= 0.85
    return round(base, 1)


def optimize_lineup(players: tuple[Player, ...] | list[Player], league: League) -> Lineup:
    available = sorted(players, key=lambda player: projected_points(player, league), reverse=True)
    starters: list[Player] = []
    used: set[str] = set()

    def fill(count: int, eligible: set[str]) -> None:
        for player in available:
            if count <= 0:
                break
            if player.id not in used and player.position in eligible:
                starters.append(player)
                used.add(player.id)
                count -= 1

    for slot, count in league.roster_slots:
        if slot in {"QB", "RB", "WR", "TE", "K", "DEF"}:
            fill(count, {slot})
    for slot, count in league.roster_slots:
        if slot == "FLEX":
            fill(count, {"RB", "WR", "TE"})
        elif slot == "SUPERFLEX":
            fill(count, {"QB", "RB", "WR", "TE"})

    bench = tuple(player for player in available if player.id not in used)
    total = round(sum(projected_points(player, league) for player in starters), 1)
    return Lineup(tuple(starters), bench, total)


def lineup_impact(roster: Roster, given: list[Player], received: list[Player], league: League) -> LineupImpact:
    before = optimize_lineup(roster.players, league)
    given_ids = {player.id for player in given}
    after_players = [player for player in roster.players if player.id not in given_ids] + received
    after = optimize_lineup(after_players, league)
    gained = round(after.projected_points - before.projected_points, 1)
    received_starts = any(player.id in {starter.id for starter in after.starters} for player in received)
    recommendation = "strong upgrade" if gained >= 5 else "upgrade" if gained >= 2 else "lateral" if gained >= -1 else "downgrade" if gained >= -3 else "strong downgrade"
    return LineupImpact(before.projected_points, after.projected_points, gained, received_starts, recommendation)


def package_value(players: list[Player], picks: list[DraftPick] | None = None) -> float:
    values = sorted(
        [player.value for player in players if player.value > 0]
        + [pick.value for pick in (picks or []) if pick.value > 0],
        reverse=True,
    )
    return round(sum(value if index == 0 else value * max(0.75, 0.9 - (index - 1) * 0.05) for index, value in enumerate(values)), 1)


def build_contexts(league: League) -> dict[str, TeamContext]:
    strength = sorted(league.rosters, key=lambda roster: sum(player.value for player in optimize_lineup(roster.players, league).starters), reverse=True)
    league_age = sum(roster.average_age for roster in league.rosters) / max(len(league.rosters), 1)
    contexts: dict[str, TeamContext] = {}
    for rank, roster in enumerate(strength, 1):
        strength_score = 1 - 2 * (rank - 1) / max(len(strength) - 1, 1)
        age_score = max(-1.0, min(1.0, (roster.average_age - league_age) / 3))
        contention = strength_score if league.mode == "redraft" else 0.62 * strength_score + 0.38 * age_score
        weight = 1.0 if league.mode == "redraft" else max(0.12, min(0.88, (contention + 1) / 2))
        window = "Win Now" if weight >= 0.62 else "Competing" if weight >= 0.42 else "Balanced" if weight >= 0.30 else "Young Core" if weight >= 0.18 else "Rebuilding"
        position_needs: dict[str, float] = {}
        for position in ("QB", "RB", "WR", "TE"):
            position_values = sorted((player.value for player in roster.players if player.position == position), reverse=True)
            top_average = sum(position_values[:2]) / max(min(len(position_values), 2), 1)
            position_needs[position] = max(0.0, min(100.0, 100 - top_average))
        contexts[roster.team_id] = TeamContext(roster, rank, roster.average_age, weight, window, position_needs)
    return contexts


def _time_profile(player: Player) -> tuple[float, float]:
    curves = {"QB": (26, 33, 0.06), "RB": (23, 27, 0.14), "WR": (24, 27, 0.10), "TE": (25, 30, 0.08)}
    if player.position not in curves or player.age <= 0:
        return 1.0, 1.0
    peak_start, peak_end, decline = curves[player.position]
    if player.age < peak_start:
        years = peak_start - player.age
        return max(0.65, 1 - years * 0.08), min(1.45, 1 + years * 0.12)
    if player.age <= peak_end:
        return 1.15, max(0.6, min(1.1, 0.6 + (peak_end - player.age + 3) * 0.06))
    years = player.age - peak_end
    return max(0.55, 1.1 - years * 0.07), max(0.15, 1 - years * decline * 3.2)


def _contextual_player_value(player: Player, context: TeamContext, receiving: bool) -> float:
    now, future = _time_profile(player)
    blend = context.win_now_weight * now + (1 - context.win_now_weight) * future
    need = 1 + context.position_needs.get(player.position, 0) / 100 * 0.35 if receiving else 1
    return player.value * blend * need


def _contextual_pick_value(pick: DraftPick, context: TeamContext) -> float:
    blend = context.win_now_weight * 0.5 + (1 - context.win_now_weight) * 1.35
    return pick.value * blend


def calc_fppg(stats: dict[str, float], player: Player, league: League) -> float:
    games = stats.get("gp", 0)
    if games <= 0:
        return 0.0
    ppr = 1.0 if league.scoring == "ppr" else 0.5 if league.scoring == "half_ppr" else 0.0
    te_bonus = 0.5 if player.position == "TE" and league.te_premium else 0.0
    total = stats.get("pass_yd", 0) * .04 + stats.get("pass_td", 0) * 4 - stats.get("pass_int", 0) * 2
    total += stats.get("rush_yd", 0) * .1 + stats.get("rush_td", 0) * 6
    total += stats.get("rec", 0) * (ppr + te_bonus) + stats.get("rec_yd", 0) * .1 + stats.get("rec_td", 0) * 6
    return total / games


def compute_projections(league: League) -> list[PlayerProjection]:
    players = {player.id: player for roster in league.rosters for player in roster.players}.values()
    team_totals: dict[str, dict[str, float]] = {}
    for player in players:
        stats = league.player_stats.get(player.id, {})
        totals = team_totals.setdefault(player.team, {"targets": 0, "carries": 0})
        totals["targets"] += stats.get("tgt", 0)
        totals["carries"] += stats.get("rush_att", 0)
    output: list[PlayerProjection] = []
    benchmarks = {"QB": 24.0 if league.superflex else 21.5, "RB": 12.0, "WR": 11.5, "TE": 10.0 if league.te_premium else 8.0}
    for player in players:
        stats = league.player_stats.get(player.id)
        fppg = calc_fppg(stats, player, league) if stats else None
        production = round(max(0, min(100, (fppg or 0) / benchmarks.get(player.position, 10) * 50))) if stats else 50
        role = 50
        signals: list[str] = []
        if stats:
            totals = team_totals.get(player.team, {})
            target_share = stats.get("tgt", 0) / max(totals.get("targets", 0), 1)
            rush_share = stats.get("rush_att", 0) / max(totals.get("carries", 0), 1)
            snap_share = stats.get("off_snp", 0) / max(stats.get("tm_off_snp", 0), 1)
            relevant_share = rush_share if player.position == "RB" else target_share if player.position in {"WR", "TE"} else snap_share
            role = round(max(0, min(100, relevant_share * (200 if player.position == "RB" else 300))))
            if snap_share >= .75:
                signals.append(f"{snap_share:.0%} snap share — secure role")
            if target_share >= .20:
                signals.append(f"{target_share:.0%} target share — high-volume role")
            if rush_share >= .35:
                signals.append(f"{rush_share:.0%} rush share — lead-back usage")
        now, future = _time_profile(player)
        trajectory_score = round(max(0, min(100, 50 + (future - now) * 80)))
        trajectory = "RISING" if trajectory_score >= 58 else "DECLINING" if trajectory_score <= 40 else "PEAK"
        if league.mode != "redraft":
            signals.append(f"{trajectory.title()} dynasty trajectory")
        edge = round(production * .6 + role * .4) if league.mode == "redraft" else round(trajectory_score * .35 + production * .35 + role * .30)
        delta = edge - player.value
        recommendation = "STRONG BUY" if delta >= 20 else "BUY" if delta >= 8 else "STRONG SELL" if delta <= -20 else "SELL" if delta <= -8 else "HOLD"
        output.append(PlayerProjection(player, round(fppg, 1) if fppg is not None else None, production, role, trajectory, edge, delta, recommendation, tuple(signals)))
    return sorted(output, key=lambda projection: projection.edge_score, reverse=True)


def evaluate_trade(
    team_a: Roster,
    team_b: Roster,
    a_gives: list[Player],
    b_gives: list[Player],
    league: League,
    a_gives_picks: list[DraftPick] | None = None,
    b_gives_picks: list[DraftPick] | None = None,
) -> TradeResult:
    value_a = package_value(a_gives, a_gives_picks)
    value_b = package_value(b_gives, b_gives_picks)
    difference = round(value_b - value_a, 1)
    fairness = round(difference / max(value_a, value_b, 1) * 100, 1)
    impact_a = lineup_impact(team_a, a_gives, b_gives, league)
    impact_b = lineup_impact(team_b, b_gives, a_gives, league)
    contexts = build_contexts(league)
    context_a, context_b = contexts[team_a.team_id], contexts[team_b.team_id]
    a_picks, b_picks = a_gives_picks or [], b_gives_picks or []
    fit_a = round(
        sum(_contextual_player_value(player, context_a, True) for player in b_gives)
        + sum(_contextual_pick_value(pick, context_a) for pick in b_picks)
        - sum(_contextual_player_value(player, context_a, False) for player in a_gives)
        - sum(_contextual_pick_value(pick, context_a) for pick in a_picks), 1,
    )
    fit_b = round(
        sum(_contextual_player_value(player, context_b, True) for player in a_gives)
        + sum(_contextual_pick_value(pick, context_b) for pick in a_picks)
        - sum(_contextual_player_value(player, context_b, False) for player in b_gives)
        - sum(_contextual_pick_value(pick, context_b) for pick in b_picks), 1,
    )
    opponent_market_edge = (value_a - value_b) / max(value_a, value_b, 1) * 100
    opponent_fit_edge = fit_b / max(team_b.total_value, 1) * 100
    acceptance = round(max(0, min(100, 15 + opponent_market_edge * 0.6 + opponent_fit_edge * 4)))
    if abs(fairness) <= 8:
        verdict = "Fair market value"
    elif fairness > 8:
        verdict = f"Favors {team_a.team_name}"
    else:
        verdict = f"Favors {team_b.team_name}"
    return TradeResult(value_a, value_b, difference, fairness, impact_a, impact_b, verdict, fit_a, fit_b, acceptance)
