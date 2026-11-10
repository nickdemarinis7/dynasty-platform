from __future__ import annotations

from dataclasses import dataclass, replace
import math
import random

from .models import DraftPick, League, Player, Roster
from .value_system import pick_profile, premium_value_cutoff
from .scoring import score_stats


_OUTCOME_BASELINE_CACHE: dict[tuple[object, ...], tuple[float, float]] = {}


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
    outgoing_starters: tuple[str, ...] = ()
    new_starters: tuple[str, ...] = ()
    internal_replacements: tuple[str, ...] = ()
    displaced_starters: tuple[str, ...] = ()
    depth_change: float = 0.0
    coverage_warnings: tuple[str, ...] = ()
    playoff_points_gained: float | None = None
    playoff_weeks_modeled: tuple[int, ...] = ()
    before_resilience: int = 0
    after_resilience: int = 0
    critical_positions: tuple[str, ...] = ()


@dataclass(frozen=True)
class DepthProfile:
    score: int
    label: str
    playable_backups: int
    critical_positions: tuple[str, ...]
    warnings: tuple[str, ...]
    position_scores: tuple[tuple[str, int], ...]
    injury_exposure: int = 0


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
    playoff_probability_before: float | None = None
    playoff_probability_after: float | None = None
    championship_probability_before: float | None = None
    championship_probability_after: float | None = None


@dataclass(frozen=True)
class TeamContext:
    roster: Roster
    league_rank: int
    average_age: float
    win_now_weight: float
    window: str
    position_needs: dict[str, float]
    power_score: float = 0
    asset_rank: int = 0
    record_rank: int | None = None
    asset_score: float = 0
    points_rank: int | None = None
    playoff_probability: int | None = None
    schedule_difficulty: int | None = None
    contender_confidence: str = "Preseason"
    deadline_urgency: int = 0
    deadline_status: str = "No deadline"
    resilience_score: int = 0
    resilience_label: str = "Unknown"
    critical_positions: tuple[str, ...] = ()


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
    market_score: int = 0
    confidence: str = "limited"


@dataclass(frozen=True)
class ProjectionProfile:
    player: Player
    expected_points: float
    floor: float
    ceiling: float
    recent_fppg: float | None
    season_fppg: float | None
    role_trend: str
    availability_probability: float
    confidence: str
    evidence: tuple[str, ...]


@dataclass(frozen=True)
class ProjectionBacktestSlice:
    position: str
    samples: int
    blended_mae: float
    baseline_mae: float
    improvement: float


@dataclass(frozen=True)
class ProjectionBacktest:
    samples: int
    blended_mae: float | None
    baseline_mae: float | None
    improvement: float | None
    directional_accuracy: float | None
    by_position: tuple[ProjectionBacktestSlice, ...]
    readiness: str


@dataclass(frozen=True)
class RecommendationBacktestSlice:
    position: str
    samples: int
    success_rate: float
    average_actual_lift: float
    false_positive_rate: float


@dataclass(frozen=True)
class RecommendationBacktest:
    samples: int
    success_rate: float | None
    average_predicted_lift: float | None
    average_actual_lift: float | None
    false_positive_rate: float | None
    role_failure_rate: float | None
    by_position: tuple[RecommendationBacktestSlice, ...]
    readiness: str


@dataclass(frozen=True)
class TradeNarrative:
    label: str
    summary: str
    reasons: tuple[str, ...]
    primary_risk: str


def projection_profile(player: Player, league: League) -> ProjectionProfile:
    """Build a transparent weekly outlook from provider, recent, and season evidence."""
    weekly_lines = [
        (week, players[player.id])
        for week, players in sorted(league.weekly_player_stats.items())
        if player.id in players
    ]
    weekly_scores = [score_stats(stats, league.scoring_settings, player.position) for _, stats in weekly_lines]
    recent_scores = weekly_scores[-3:]
    recent_fppg = round(sum(recent_scores) / len(recent_scores), 1) if recent_scores else None
    season_stats = league.player_stats.get(player.id)
    season_fppg = round(calc_fppg(season_stats, player, league), 1) if season_stats and season_stats.get("gp", 0) > 0 else None
    provider = league.weekly_points.get(player.id)

    evidence: list[str] = []
    weighted: list[tuple[float, float]] = []
    if provider is not None and provider > 0:
        weighted.append((provider, .55))
        evidence.append("Current-week provider projection")
    if recent_fppg is not None:
        weighted.append((recent_fppg, .30 if provider else .70))
        evidence.append(f"Last {len(recent_scores)} scored weeks")
    if season_fppg is not None:
        weighted.append((season_fppg, .15 if provider else .30))
        evidence.append("Season scoring baseline")
    total_weight = sum(weight for _, weight in weighted)
    expected = sum(value * weight for value, weight in weighted) / total_weight if total_weight else 0.0

    if len(weekly_scores) >= 3:
        ordered = sorted(weekly_scores)
        floor = ordered[max(0, round((len(ordered) - 1) * .2))]
        ceiling = ordered[min(len(ordered) - 1, round((len(ordered) - 1) * .8))]
    else:
        spread = max(2.0, expected * .30)
        floor, ceiling = max(0.0, expected - spread), expected + spread

    def opportunities(stats: dict[str, float]) -> float:
        if player.position == "QB":
            return stats.get("pass_att", 0)
        if player.position == "RB":
            return stats.get("rush_att", 0) + stats.get("tgt", 0)
        return stats.get("tgt", 0)

    role_trend = "Stable"
    if len(weekly_lines) >= 4:
        recent_role = sum(opportunities(stats) for _, stats in weekly_lines[-2:]) / 2
        prior_lines = weekly_lines[-5:-2]
        prior_role = sum(opportunities(stats) for _, stats in prior_lines) / max(len(prior_lines), 1)
        if prior_role > 0 and recent_role >= prior_role * 1.18:
            role_trend = "Rising"
        elif prior_role > 0 and recent_role <= prior_role * .82:
            role_trend = "Falling"
        evidence.append(f"Recent opportunity trend: {role_trend.lower()}")

    status = (player.injury_status or "active").lower()
    availability = 0.0 if status in {"out", "o", "ir", "pup", "nfi", "suspended", "sus"} else .35 if status in {"doubtful", "d"} else .80 if status in {"questionable", "q"} else 1.0
    expected *= availability
    confidence_points = (35 if provider else 0) + min(45, len(weekly_scores) * 9) + (20 if season_fppg is not None else 0)
    if availability < 1:
        confidence_points -= 15
        evidence.append(f"Availability adjustment: {availability:.0%}")
    confidence = "High" if confidence_points >= 80 else "Medium" if confidence_points >= 55 else "Low"
    return ProjectionProfile(
        player, round(expected, 1), round(floor * availability, 1), round(ceiling * availability, 1),
        recent_fppg, season_fppg, role_trend, availability, confidence, tuple(evidence),
    )


def compute_projection_profiles(league: League) -> list[ProjectionProfile]:
    players = {player.id: player for roster in league.rosters for player in roster.players}.values()
    return sorted((projection_profile(player, league) for player in players), key=lambda item: item.expected_points, reverse=True)


def backtest_projection_model(league: League, minimum_history: int = 3) -> ProjectionBacktest:
    """Walk completed weeks forward without using future information.

    Historical provider projections are not available, so this validates the
    recency-weighted fallback against a simple prior-season-average baseline.
    """
    player_positions = {player.id: player.position for roster in league.rosters for player in roster.players}
    observations: list[tuple[str, float, float, float, bool]] = []
    histories: dict[str, list[float]] = {}
    for _, weekly_players in sorted(league.weekly_player_stats.items()):
        for player_id, stats in weekly_players.items():
            position = player_positions.get(player_id)
            if not position:
                continue
            actual = score_stats(stats, league.scoring_settings, position)
            prior = histories.setdefault(player_id, [])
            if len(prior) >= minimum_history:
                baseline = sum(prior) / len(prior)
                recent = sum(prior[-3:]) / min(3, len(prior))
                blended = recent * .70 + baseline * .30
                baseline_error = abs(actual - baseline)
                blended_error = abs(actual - blended)
                # Direction asks whether the model correctly identified an
                # above/below-baseline week, with a small neutral band.
                predicted_delta = blended - baseline
                actual_delta = actual - baseline
                direction = abs(predicted_delta) < .5 and abs(actual_delta) < .5 or predicted_delta * actual_delta > 0
                observations.append((position, blended_error, baseline_error, actual, direction))
            prior.append(actual)

    def summarize(position: str, rows: list[tuple[str, float, float, float, bool]]) -> ProjectionBacktestSlice:
        blended_mae = sum(row[1] for row in rows) / len(rows)
        baseline_mae = sum(row[2] for row in rows) / len(rows)
        improvement = (baseline_mae - blended_mae) / baseline_mae if baseline_mae > 0 else 0.0
        return ProjectionBacktestSlice(position, len(rows), round(blended_mae, 2), round(baseline_mae, 2), round(improvement, 3))

    slices = tuple(
        summarize(position, [row for row in observations if row[0] == position])
        for position in ("QB", "RB", "WR", "TE")
        if any(row[0] == position for row in observations)
    )
    if not observations:
        return ProjectionBacktest(0, None, None, None, None, (), "Insufficient history")
    blended_mae = sum(row[1] for row in observations) / len(observations)
    baseline_mae = sum(row[2] for row in observations) / len(observations)
    improvement = (baseline_mae - blended_mae) / baseline_mae if baseline_mae > 0 else 0.0
    readiness = "Early signal" if len(observations) < 100 else "Usable sample" if len(observations) < 400 else "Strong sample"
    return ProjectionBacktest(
        len(observations), round(blended_mae, 2), round(baseline_mae, 2), round(improvement, 3),
        round(sum(row[4] for row in observations) / len(observations), 3), slices, readiness,
    )


def backtest_recommendation_model(league: League, minimum_history: int = 3) -> RecommendationBacktest:
    """Walk forward synthetic lineup upgrades using only prior-week production.

    This validates player selection and lineup fit. Historical market prices,
    ownership changes, and manager acceptance are not reconstructed, so this is
    intentionally not presented as a full trade-market backtest.
    """
    players = {
        player.id: replace(player, injury_status=None)
        for roster in league.rosters for player in roster.players
    }
    if len(league.rosters) < 2:
        return RecommendationBacktest(0, None, None, None, None, None, (), "Insufficient history")
    histories: dict[str, list[float]] = {}
    observations: list[tuple[str, float, float, bool]] = []
    for _, weekly_stats in sorted(league.weekly_player_stats.items()):
        scored = {
            player_id: score_stats(stats, league.scoring_settings, players[player_id].position)
            for player_id, stats in weekly_stats.items() if player_id in players
        }
        active_nfl_teams = {players[player_id].team for player_id in scored if players[player_id].team not in {"", "FA"}}
        actual = {
            player_id: scored.get(player_id, 0.0)
            for player_id, player in players.items()
            if player.team in active_nfl_teams
        }
        predicted = {
            player_id: (sum(scores[-3:]) / min(3, len(scores))) * .70 + (sum(scores) / len(scores)) * .30
            for player_id, scores in histories.items() if player_id in players and len(scores) >= minimum_history
        }
        if predicted:
            prediction_league = replace(league, weekly_points=predicted, weekly_player_stats={}, player_stats={})
            actual_league = replace(league, weekly_points=actual, weekly_player_stats={}, player_stats={})
            for roster in league.rosters:
                roster_players = tuple(players[player.id] for player in roster.players if player.id in predicted)
                if not roster_players:
                    continue
                replay_roster = replace(roster, players=roster_players, reserve_player_ids=(), taxi_player_ids=())
                before_predicted = optimize_lineup(replay_roster.players, prediction_league).projected_points
                own_ids = {player.id for player in replay_roster.players}
                external = [player for player_id, player in players.items() if player_id in predicted and player_id not in own_ids]
                for position in ("QB", "RB", "WR", "TE"):
                    incoming = max(
                        (player for player in external if player.position == position),
                        key=lambda player: predicted[player.id], default=None,
                    )
                    if incoming is None or incoming.id not in actual:
                        continue
                    best: tuple[float, Player, tuple[Player, ...]] | None = None
                    for outgoing in (player for player in replay_roster.players if player.position == position and player.id in actual):
                        after_players = tuple(player for player in replay_roster.players if player.id != outgoing.id) + (incoming,)
                        predicted_lift = optimize_lineup(after_players, prediction_league).projected_points - before_predicted
                        if best is None or predicted_lift > best[0]:
                            best = (predicted_lift, outgoing, after_players)
                    if best is None or best[0] < 1.5:
                        continue
                    predicted_lift, outgoing, after_players = best
                    before_actual = optimize_lineup(replay_roster.players, actual_league).projected_points
                    after_actual = optimize_lineup(after_players, actual_league).projected_points
                    actual_lift = after_actual - before_actual
                    incoming_role_failure = actual[incoming.id] < max(2.0, predicted[incoming.id] * .35)
                    observations.append((position, predicted_lift, actual_lift, incoming_role_failure))
        for player_id, score in actual.items():
            histories.setdefault(player_id, []).append(score)

    def summarize(position: str, rows: list[tuple[str, float, float, bool]]) -> RecommendationBacktestSlice:
        return RecommendationBacktestSlice(
            position=position,
            samples=len(rows),
            success_rate=round(sum(row[2] > 0 for row in rows) / len(rows), 3),
            average_actual_lift=round(sum(row[2] for row in rows) / len(rows), 2),
            false_positive_rate=round(sum(row[2] <= 0 for row in rows) / len(rows), 3),
        )

    slices = tuple(
        summarize(position, [row for row in observations if row[0] == position])
        for position in ("QB", "RB", "WR", "TE") if any(row[0] == position for row in observations)
    )
    if not observations:
        return RecommendationBacktest(0, None, None, None, None, None, (), "Insufficient history")
    sample_count = len(observations)
    readiness = "Early signal" if sample_count < 40 else "Usable sample" if sample_count < 120 else "Strong sample"
    return RecommendationBacktest(
        samples=sample_count,
        success_rate=round(sum(row[2] > 0 for row in observations) / sample_count, 3),
        average_predicted_lift=round(sum(row[1] for row in observations) / sample_count, 2),
        average_actual_lift=round(sum(row[2] for row in observations) / sample_count, 2),
        false_positive_rate=round(sum(row[2] <= 0 for row in observations) / sample_count, 3),
        role_failure_rate=round(sum(row[3] for row in observations) / sample_count, 3),
        by_position=slices,
        readiness=readiness,
    )


def projected_points(player: Player, league: League) -> float:
    weekly = league.weekly_points.get(player.id)
    if weekly is not None and weekly > 0:
        base = weekly
    elif league.weekly_player_stats:
        # Use the recency-aware outlook when a provider has no projection.
        return projection_profile(player, league).expected_points
    else:
        stats = league.player_stats.get(player.id)
        base = calc_fppg(stats, player, league) if stats and stats.get("gp", 0) > 0 else 0.0
    # Availability applies even when a provider published a projection or the
    # player has a healthy season average. Market value is never used as PPG.
    status = (player.injury_status or "active").lower()
    if status in {"out", "o", "ir", "pup", "nfi", "suspended", "sus"}:
        base = 0
    elif status in {"doubtful", "d"}:
        base *= 0.3
    elif status in {"questionable", "q"}:
        base *= 0.85
    return round(base, 1)


def active_roster_players(roster: Roster) -> tuple[Player, ...]:
    inactive_ids = set(roster.reserve_player_ids) | set(roster.taxi_player_ids)
    return tuple(player for player in roster.players if player.id not in inactive_ids)


def optimize_lineup(players: tuple[Player, ...] | list[Player], league: League) -> Lineup:
    available = sorted(players, key=lambda player: (projected_points(player, league), player.value, player.id), reverse=True)
    eligibility = {
        "QB": {"QB"}, "RB": {"RB"}, "WR": {"WR"}, "TE": {"TE"}, "K": {"K"}, "DEF": {"DEF"},
        "FLEX": {"RB", "WR", "TE"}, "SUPERFLEX": {"QB", "RB", "WR", "TE"},
    }
    slots = [slot for slot, count in league.roster_slots if slot in eligibility for _ in range(count)]
    if not slots:
        return Lineup((), tuple(available), 0.0)

    # Exact maximum-weight assignment. A player is considered once and can fill
    # at most one slot, so FLEX/SUPERFLEX ordering cannot change the result.
    # Typical fantasy lineups have <= 12 slots, keeping this bitmask DP small.
    states: dict[int, tuple[float, tuple[int, ...]]] = {0: (0.0, ())}
    for player_index, player in enumerate(available):
        points = projected_points(player, league)
        updated = dict(states)
        for mask, (score, assignments) in states.items():
            for slot_index, slot in enumerate(slots):
                bit = 1 << slot_index
                if mask & bit or player.position not in eligibility[slot]:
                    continue
                next_mask = mask | bit
                candidate = (score + points, assignments + (player_index,))
                existing = updated.get(next_mask)
                if existing is None or candidate[0] > existing[0]:
                    updated[next_mask] = candidate
        states = updated
    _, (_, starter_indices) = max(states.items(), key=lambda item: (item[1][0], item[0].bit_count()))
    starter_set = set(starter_indices)
    starters = tuple(player for index, player in enumerate(available) if index in starter_set)
    bench = tuple(player for index, player in enumerate(available) if index not in starter_set)
    total = round(sum(projected_points(player, league) for player in starters), 1)
    return Lineup(starters, bench, total)


def depth_profile(players: tuple[Player, ...] | list[Player], league: League, lineup: Lineup | None = None) -> DepthProfile:
    lineup = lineup or optimize_lineup(players, league)
    starters_by_position = {
        position: [player for player in lineup.starters if player.position == position]
        for position in ("QB", "RB", "WR", "TE")
    }
    unavailable = {"out", "o", "ir", "pup", "nfi", "suspended", "sus", "doubtful", "d"}
    questionable = {"questionable", "q"}
    score_total = 0.0
    weighted_positions = 0
    playable_backups = 0
    critical: list[str] = []
    warnings: list[str] = []
    position_scores: list[tuple[str, int]] = []
    injury_exposure = sum((player.injury_status or "").lower() in unavailable | questionable for player in lineup.starters)
    for position, starters in starters_by_position.items():
        starter_count = len(starters)
        if starter_count == 0:
            continue
        healthy = sorted(
            (
                player for player in players
                if player.position == position and (player.injury_status or "active").lower() not in unavailable
            ),
            key=lambda player: (projected_points(player, league), player.value),
            reverse=True,
        )
        backups = [player for player in healthy if player.id not in {starter.id for starter in starters}]
        starter_floor = min((projected_points(player, league) for player in starters), default=0)
        waiver = max((projected_points(player, league) for player in league.free_agents if player.position == position), default=0)
        threshold = max(4.0, starter_floor * .45, waiver)
        playable = [player for player in backups if projected_points(player, league) >= threshold or player.value >= 15]
        preferred = 2 if position in {"RB", "WR"} and starter_count >= 2 else 1
        playable_backups += len(playable)
        best_replacement = max([projected_points(player, league) for player in playable] + [waiver], default=0)
        dropoff = max(0.0, starter_floor - best_replacement)
        coverage = min(1.0, len(playable) / preferred)
        dropoff_quality = 1.0 if starter_floor <= 0 else max(0.0, 1 - dropoff / starter_floor)
        position_score = round((coverage * .65 + dropoff_quality * .35) * 100)
        position_scores.append((position, position_score))
        weight = max(1, starter_count)
        score_total += position_score * weight
        weighted_positions += weight
        if not playable or (starter_floor > 0 and dropoff / starter_floor > .55):
            critical.append(position)
            warnings.append(f"{position}: no reliable replacement behind {starter_count} starter{'s' if starter_count != 1 else ''}")
        elif len(playable) < preferred:
            warnings.append(f"{position}: only {len(playable)} playable backup for {starter_count} starters")
    score = round(score_total / max(weighted_positions, 1) - injury_exposure * 5)
    score = max(0, min(100, score))
    label = "Strong" if score >= 75 and not critical else "Stable" if score >= 60 and len(critical) <= 1 else "Thin" if score >= 40 else "Critical"
    return DepthProfile(score, label, playable_backups, tuple(critical), tuple(warnings), tuple(position_scores), injury_exposure)


def _depth_profile(players: tuple[Player, ...] | list[Player], league: League) -> tuple[float, tuple[str, ...]]:
    profile = depth_profile(players, league)
    return float(profile.score), profile.warnings


def lineup_impact(
    roster: Roster,
    given: list[Player],
    received: list[Player],
    league: League,
    model_playoffs: bool = True,
) -> LineupImpact:
    active_players = active_roster_players(roster)
    before = optimize_lineup(active_players, league)
    given_ids = {player.id for player in given}
    after_players = [player for player in active_players if player.id not in given_ids] + received
    after = optimize_lineup(after_players, league)
    gained = round(after.projected_points - before.projected_points, 1)
    received_starts = any(player.id in {starter.id for starter in after.starters} for player in received)
    recommendation = "strong upgrade" if gained >= 5 else "upgrade" if gained >= 2 else "lateral" if gained >= -1 else "downgrade" if gained >= -3 else "strong downgrade"
    before_ids = {player.id for player in before.starters}
    after_ids = {player.id for player in after.starters}
    received_ids = {player.id for player in received}
    outgoing = tuple(player.name for player in before.starters if player.id in given_ids)
    new = tuple(player.name for player in after.starters if player.id not in before_ids)
    replacements = tuple(player.name for player in after.starters if player.id not in before_ids and player.id not in received_ids)
    displaced = tuple(player.name for player in before.starters if player.id not in after_ids and player.id not in given_ids)
    before_profile = depth_profile(active_players, league, before)
    after_profile = depth_profile(after_players, league, after)
    playoff_deltas: list[float] = []
    playoff_weeks: list[int] = []
    for week, points in sorted(league.playoff_weekly_points.items()) if model_playoffs else ():
        if not points:
            continue
        week_league = replace(league, weekly_points=points, playoff_weekly_points={})
        week_before = optimize_lineup(active_players, week_league)
        week_after = optimize_lineup(after_players, week_league)
        playoff_deltas.append(week_after.projected_points - week_before.projected_points)
        playoff_weeks.append(week)
    playoff_gain = round(sum(playoff_deltas) / len(playoff_deltas), 1) if playoff_deltas else None
    return LineupImpact(
        before.projected_points,
        after.projected_points,
        gained,
        received_starts,
        recommendation,
        outgoing,
        new,
        replacements,
        displaced,
        round(after_profile.score - before_profile.score, 1),
        after_profile.warnings,
        playoff_gain,
        tuple(playoff_weeks),
        before_profile.score,
        after_profile.score,
        after_profile.critical_positions,
    )


def package_value(players: list[Player], picks: list[DraftPick] | None = None, league: League | None = None) -> float:
    """Sum market assets without reapplying a consolidation premium.

    FantasyCalc's nonlinear player curve is learned from completed trades,
    including multi-player deals. Uneven player counts are handled separately
    as a roster-spot adjustment in ``evaluate_trade``.
    """
    player_value = sum(player.value for player in players if player.value > 0)
    pick_value = sum(
        pick_profile(pick, league).adjusted_value if league else pick.value
        for pick in (picks or []) if pick.value > 0
    )
    return round(player_value + pick_value, 1)


def replacement_player_value(league: League) -> float:
    """Estimate the option value of one newly opened active-roster spot."""
    available = sorted((player.value for player in league.free_agents if player.value > 0), reverse=True)
    if available:
        # Avoid pricing the spot from a single anomalous free agent. The fifth
        # best available player is a reasonable immediately-addable baseline.
        observed = available[min(4, len(available) - 1)]
    else:
        # FantasyCalc's published dynasty baseline is roughly 425 on its raw
        # scale; provider values in this app are divided by 100.
        observed = 4.25
    cap = max(2.0, premium_value_cutoff(league) * .08)
    return round(max(0.5, min(observed, cap)), 2)


def build_contexts(league: League) -> dict[str, TeamContext]:
    def required(position: str) -> int:
        counts = dict(league.roster_slots)
        base = counts.get(position, 0)
        if position == "QB" and counts.get("SUPERFLEX", 0):
            base += counts["SUPERFLEX"]
        if position in {"RB", "WR"} and counts.get("FLEX", 0):
            base += 1
        return max(1, base)

    position_units: dict[str, dict[str, float]] = {position: {} for position in ("QB", "RB", "WR", "TE")}
    for roster in league.rosters:
        active = active_roster_players(roster)
        for position in position_units:
            values = sorted((player.value for player in active if player.position == position), reverse=True)
            position_units[position][roster.team_id] = sum(values[:required(position)])

    def power(roster: Roster) -> float:
        active = active_roster_players(roster)
        lineup = optimize_lineup(active, league)
        starter_market = sum(player.value for player in lineup.starters)
        depth_market = sum(player.value for player in lineup.bench)
        pick_market = sum(pick_profile(pick, league).adjusted_value for pick in roster.draft_picks)
        if league.mode == "redraft":
            return lineup.projected_points
        return starter_market + depth_market * .2 + pick_market * .25

    power_by_team = {roster.team_id: power(roster) for roster in league.rosters}
    strength = sorted(league.rosters, key=lambda roster: power_by_team[roster.team_id], reverse=True)
    asset_rank = {roster.team_id: rank for rank, roster in enumerate(strength, 1)}
    season_started = any(roster.games_played > 0 for roster in league.rosters)
    standings = sorted(
        league.rosters,
        key=lambda roster: (roster.win_percentage, roster.points_for, power_by_team[roster.team_id]),
        reverse=True,
    )
    record_rank = {roster.team_id: rank for rank, roster in enumerate(standings, 1)}
    points_order = sorted(league.rosters, key=lambda roster: roster.points_for, reverse=True)
    points_rank = {roster.team_id: rank for rank, roster in enumerate(points_order, 1)}
    league_age = sum(roster.average_age for roster in league.rosters) / max(len(league.rosters), 1)

    def rank_score(rank: int) -> float:
        return 1 - 2 * (rank - 1) / max(len(league.rosters) - 1, 1)

    contention_by_team: dict[str, float] = {}
    for roster in league.rosters:
        strength_score = rank_score(asset_rank[roster.team_id])
        age_score = max(-1.0, min(1.0, (roster.average_age - league_age) / 3))
        if season_started:
            results_score = 0.70 * rank_score(record_rank[roster.team_id]) + 0.30 * rank_score(points_rank[roster.team_id])
            contention = 0.70 * results_score + 0.30 * strength_score if league.mode == "redraft" else 0.65 * results_score + 0.25 * strength_score + 0.10 * age_score
        else:
            contention = strength_score if league.mode == "redraft" else 0.62 * strength_score + 0.38 * age_score
        contention_by_team[roster.team_id] = contention

    competitive_order = sorted(
        league.rosters,
        key=lambda roster: (contention_by_team[roster.team_id], roster.win_percentage, roster.points_for),
        reverse=True,
    )
    competitive_rank = {roster.team_id: rank for rank, roster in enumerate(competitive_order, 1)}

    playoff_probability: dict[str, int] = {}
    if season_started and league.remaining_matchups:
        qualified = {roster.team_id: 0 for roster in league.rosters}
        rng = random.Random(sum(ord(character) for character in league.id) + league.current_week)
        simulations = 1500
        for _ in range(simulations):
            wins = {roster.team_id: roster.wins + roster.ties * 0.5 for roster in league.rosters}
            for _, team_a, team_b in league.remaining_matchups:
                if team_a not in wins or team_b not in wins:
                    continue
                difference = contention_by_team[team_a] - contention_by_team[team_b]
                chance_a = 1 / (1 + math.exp(-2.25 * difference))
                wins[team_a if rng.random() < chance_a else team_b] += 1
            finish = sorted(
                league.rosters,
                key=lambda roster: (wins[roster.team_id], roster.points_for, contention_by_team[roster.team_id]),
                reverse=True,
            )
            for roster in finish[:league.playoff_teams]:
                qualified[roster.team_id] += 1
        playoff_probability = {team_id: round(count / simulations * 100) for team_id, count in qualified.items()}

    opponents: dict[str, list[str]] = {roster.team_id: [] for roster in league.rosters}
    for _, team_a, team_b in league.remaining_matchups:
        if team_a in opponents and team_b in opponents:
            opponents[team_a].append(team_b)
            opponents[team_b].append(team_a)

    top_third = max(1, math.ceil(len(league.rosters) / 3))
    bottom_half = math.ceil(len(league.rosters) / 2)
    contexts: dict[str, TeamContext] = {}
    for roster in league.rosters:
        contention = contention_by_team[roster.team_id]
        weight = 1.0 if league.mode == "redraft" else max(0.12, min(0.88, (contention + 1) / 2))
        playoff_odds = playoff_probability.get(roster.team_id)
        if league.mode != "redraft" and playoff_odds is not None:
            weight = max(0.12, min(0.92, weight + (playoff_odds - 50) / 100 * 0.15))
        if league.trade_deadline_week is None:
            deadline_urgency, deadline_status = 0, "No deadline"
        else:
            weeks_to_deadline = league.trade_deadline_week - league.current_week
            if weeks_to_deadline < 0:
                deadline_urgency, deadline_status = 100, "Deadline passed"
            elif weeks_to_deadline == 0:
                deadline_urgency, deadline_status = 100, "Deadline week"
            else:
                deadline_urgency = max(10, min(90, 100 - weeks_to_deadline * 18))
                deadline_status = f"{weeks_to_deadline} week{'s' if weeks_to_deadline != 1 else ''} to deadline"
            if league.mode != "redraft" and weeks_to_deadline >= 0 and (playoff_odds or 0) >= 60:
                weight = min(0.94, weight + deadline_urgency / 100 * 0.06)
        window = "Win Now" if weight >= 0.62 else "Competing" if weight >= 0.42 else "Balanced" if weight >= 0.30 else "Young Core" if weight >= 0.18 else "Rebuilding"
        if not season_started:
            confidence = "Preseason"
        elif record_rank[roster.team_id] <= top_third and points_rank[roster.team_id] <= top_third:
            confidence = "Proven contender"
        elif record_rank[roster.team_id] <= top_third and points_rank[roster.team_id] > bottom_half:
            confidence = "Fragile contender"
        elif record_rank[roster.team_id] > bottom_half and points_rank[roster.team_id] <= top_third:
            confidence = "Unlucky contender"
        elif record_rank[roster.team_id] <= bottom_half:
            confidence = "In the hunt"
        else:
            confidence = "Long shot"
        opponent_ids = opponents[roster.team_id]
        schedule_difficulty = round(sum((contention_by_team[team_id] + 1) * 50 for team_id in opponent_ids) / len(opponent_ids)) if opponent_ids else None
        position_needs: dict[str, float] = {}
        for position in ("QB", "RB", "WR", "TE"):
            ordered = sorted(position_units[position].values(), reverse=True)
            unit = position_units[position][roster.team_id]
            unit_rank = ordered.index(unit) + 1
            relative_need = (unit_rank - 1) / max(len(ordered) - 1, 1) * 100
            filled = sum(player.position == position and player.value > 0 for player in active_roster_players(roster))
            depth_penalty = max(0, required(position) - filled) * 15
            position_needs[position] = round(min(100.0, relative_need + depth_penalty), 1)
        resilience = depth_profile(active_roster_players(roster), league)
        contexts[roster.team_id] = TeamContext(
            roster=roster,
            league_rank=competitive_rank[roster.team_id],
            average_age=roster.average_age,
            win_now_weight=weight,
            window=window,
            position_needs=position_needs,
            power_score=round((contention + 1) * 50, 1),
            asset_rank=asset_rank[roster.team_id],
            record_rank=record_rank[roster.team_id] if season_started else None,
            asset_score=round(power_by_team[roster.team_id], 1),
            points_rank=points_rank[roster.team_id] if season_started else None,
            playoff_probability=playoff_odds,
            schedule_difficulty=schedule_difficulty,
            contender_confidence=confidence,
            deadline_urgency=deadline_urgency,
            deadline_status=deadline_status,
            resilience_score=resilience.score,
            resilience_label=resilience.label,
            critical_positions=resilience.critical_positions,
        )
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


def _contextual_player_value(player: Player, context: TeamContext) -> float:
    now, future = _time_profile(player)
    blend = context.win_now_weight * now + (1 - context.win_now_weight) * future
    need = 1 + context.position_needs.get(player.position, 0) / 100 * 0.35
    return player.value * blend * need


def _contextual_pick_value(pick: DraftPick, context: TeamContext, league: League) -> float:
    blend = context.win_now_weight * 0.5 + (1 - context.win_now_weight) * 1.35
    return pick_profile(pick, league).adjusted_value * blend


def calc_fppg(stats: dict[str, float], player: Player, league: League) -> float:
    games = stats.get("gp", 0)
    if games <= 0:
        return 0.0
    scoring = league.scoring_settings or {
        "rec": 1.0 if league.scoring == "ppr" else 0.5 if league.scoring == "half_ppr" else 0.0,
        "bonus_rec_te": 0.5 if league.te_premium else 0.0,
    }
    return score_stats(stats, scoring, player.position) / games


def compute_projections(league: League) -> list[PlayerProjection]:
    players = {player.id: player for roster in league.rosters for player in roster.players}.values()
    team_totals: dict[str, dict[str, float]] = {}
    for player_id, stats in league.player_stats.items():
        team = league.player_teams.get(player_id)
        if not team:
            continue
        totals = team_totals.setdefault(team, {"targets": 0, "carries": 0})
        totals["targets"] += stats.get("tgt", 0)
        totals["carries"] += stats.get("rush_att", 0)
    raw_output: list[tuple[Player, float | None, int, int, str, int, tuple[str, ...], str]] = []
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
        curves = {"QB": (26, 33), "RB": (23, 27), "WR": (24, 27), "TE": (25, 30)}
        peak_start, peak_end = curves.get(player.position, (25, 29))
        if player.age <= 0:
            trajectory_score = 50
        elif player.age < peak_start:
            trajectory_score = min(78, 62 + (peak_start - player.age) * 4)
        elif player.age <= peak_end:
            trajectory_score = 50
        else:
            trajectory_score = max(10, 50 - (player.age - peak_end) * 12)
        trajectory = "RISING" if trajectory_score >= 58 else "DECLINING" if trajectory_score <= 40 else "PEAK"
        if league.mode != "redraft":
            signals.append(f"{trajectory.title()} dynasty trajectory")
        edge = round(production * .6 + role * .4) if league.mode == "redraft" else round(trajectory_score * .35 + production * .35 + role * .30)
        games = float((stats or {}).get("gp") or 0)
        unavailable = (player.injury_status or "").lower() in {"out", "o", "ir", "pup", "nfi", "suspended", "sus", "doubtful", "d"}
        confidence = "strong" if games >= 4 and fppg is not None and player.team in team_totals and not unavailable else "limited"
        raw_output.append((player, round(fppg, 1) if fppg is not None else None, production, role, trajectory, edge, tuple(signals), confidence))

    def percentile(value: float, values: list[float]) -> int:
        if len(values) <= 1:
            return 50
        below = sum(item < value for item in values)
        equal = sum(item == value for item in values)
        return round((below + max(0, equal - 1) / 2) / (len(values) - 1) * 100)

    output: list[PlayerProjection] = []
    for position in ("QB", "RB", "WR", "TE", "K", "DEF"):
        group = [item for item in raw_output if item[0].position == position]
        model_values = [item[5] for item in group]
        market_values = [item[0].value for item in group]
        for player, fppg, production, role, trajectory, raw_edge, signals, confidence in group:
            edge = percentile(raw_edge, model_values)
            market = percentile(player.value, market_values)
            delta = edge - market
            recommendation = (
                "LOW CONFIDENCE" if confidence == "limited"
                else "MODEL WELL ABOVE MARKET" if delta >= 20
                else "MODEL ABOVE MARKET" if delta >= 10
                else "MARKET WELL ABOVE MODEL" if delta <= -20
                else "MARKET ABOVE MODEL" if delta <= -10
                else "MARKET ALIGNED"
            )
            output.append(PlayerProjection(player, fppg, production, role, trajectory, edge, delta, recommendation, signals, market, confidence))
    return sorted(output, key=lambda projection: (projection.edge_score, projection.player.value), reverse=True)


def _trade_outcome_probabilities(
    team_a: Roster,
    team_b: Roster,
    a_gives: list[Player],
    b_gives: list[Player],
    league: League,
) -> tuple[float, float, float, float]:
    """Simulate playoff and title odds before and after a proposed trade."""
    if not any(roster.games_played for roster in league.rosters):
        return 0.0, 0.0, 0.0, 0.0

    def traded(roster: Roster, outgoing: list[Player], incoming: list[Player]) -> Roster:
        outgoing_ids = {player.id for player in outgoing}
        players = tuple(player for player in roster.players if player.id not in outgoing_ids) + tuple(incoming)
        return replace(roster, players=players)

    after_a = traded(team_a, a_gives, b_gives)
    after_b = traded(team_b, b_gives, a_gives)
    after_rosters = tuple(
        after_a if roster.team_id == team_a.team_id else after_b if roster.team_id == team_b.team_id else roster
        for roster in league.rosters
    )

    def lineup_power(roster: Roster, scenario_league: League) -> float:
        weeks = scenario_league.playoff_weekly_points
        if weeks:
            values = [
                optimize_lineup(active_roster_players(roster), replace(scenario_league, weekly_points=points, playoff_weekly_points={})).projected_points
                for points in weeks.values() if points
            ]
            if values:
                return sum(values) / len(values)
        projected = optimize_lineup(active_roster_players(roster), scenario_league).projected_points
        return projected or roster.points_for / max(roster.games_played, 1)

    def simulate(rosters: tuple[Roster, ...]) -> tuple[float, float]:
        scenario = replace(league, rosters=rosters)
        powers = {roster.team_id: lineup_power(roster, scenario) for roster in rosters}
        qualified = titles = 0
        simulations = 160
        # Reuse the same deterministic random stream before and after every
        # trade. This common-random-numbers design reduces variance in the
        # reported delta and keeps the baseline identical across packages.
        rng = random.Random(sum(ord(character) for character in league.id) + 17)

        def win_probability(left: str, right: str) -> float:
            # Weekly fantasy results are far noisier than point projections.
            # A wider scale prevents a modest projected edge from becoming a
            # near-certain playoff result.
            return 1 / (1 + math.exp(-(powers[left] - powers[right]) / 18.0))

        for _ in range(simulations):
            wins = {roster.team_id: roster.wins + roster.ties * .5 for roster in rosters}
            for _, left, right in league.remaining_matchups:
                if left in wins and right in wins:
                    wins[left if rng.random() < win_probability(left, right) else right] += 1
            field = sorted(rosters, key=lambda roster: (wins[roster.team_id], roster.points_for, powers[roster.team_id]), reverse=True)[:league.playoff_teams]
            playoff_ids = [roster.team_id for roster in field]
            if team_a.team_id not in playoff_ids:
                continue
            qualified += 1
            alive = playoff_ids
            while len(alive) > 1:
                next_round: list[str] = []
                if len(alive) % 2:
                    next_round.append(alive[0])
                    alive = alive[1:]
                for index in range(len(alive) // 2):
                    left, right = alive[index], alive[-(index + 1)]
                    next_round.append(left if rng.random() < win_probability(left, right) else right)
                alive = next_round
            if alive and alive[0] == team_a.team_id:
                titles += 1
        return round(qualified / simulations * 100, 1), round(titles / simulations * 100, 1)

    baseline_key = (
        league.id, league.imported_at, team_a.team_id, league.current_week,
        tuple((roster.team_id, roster.wins, roster.losses, roster.ties, roster.points_for) for roster in league.rosters),
        tuple(sorted((week, left, right) for week, left, right in league.remaining_matchups)),
        tuple(sorted((week, tuple(sorted(points.items()))) for week, points in league.playoff_weekly_points.items())),
    )
    before = _OUTCOME_BASELINE_CACHE.get(baseline_key)
    if before is None:
        before = simulate(league.rosters)
        if len(_OUTCOME_BASELINE_CACHE) >= 32:
            _OUTCOME_BASELINE_CACHE.pop(next(iter(_OUTCOME_BASELINE_CACHE)))
        _OUTCOME_BASELINE_CACHE[baseline_key] = before
    before_playoffs, before_title = before
    after_playoffs, after_title = simulate(after_rosters)
    return before_playoffs, after_playoffs, before_title, after_title


def evaluate_trade(
    team_a: Roster,
    team_b: Roster,
    a_gives: list[Player],
    b_gives: list[Player],
    league: League,
    a_gives_picks: list[DraftPick] | None = None,
    b_gives_picks: list[DraftPick] | None = None,
    contexts: dict[str, TeamContext] | None = None,
    model_playoffs: bool = True,
) -> TradeResult:
    value_a = package_value(a_gives, a_gives_picks, league)
    value_b = package_value(b_gives, b_gives_picks, league)
    player_count_difference = len(a_gives) - len(b_gives)
    roster_spot_value = replacement_player_value(league)
    if player_count_difference > 0:
        value_b = round(value_b + roster_spot_value * player_count_difference, 1)
    elif player_count_difference < 0:
        value_a = round(value_a + roster_spot_value * abs(player_count_difference), 1)
    difference = round(value_b - value_a, 1)
    fairness = round(difference / max(value_a, value_b, 1) * 100, 1)
    impact_a = lineup_impact(team_a, a_gives, b_gives, league, model_playoffs)
    impact_b = lineup_impact(team_b, b_gives, a_gives, league, model_playoffs)
    contexts = contexts or build_contexts(league)
    context_a, context_b = contexts[team_a.team_id], contexts[team_b.team_id]
    a_picks, b_picks = a_gives_picks or [], b_gives_picks or []
    fit_a = round(
        sum(_contextual_player_value(player, context_a) for player in b_gives)
        + sum(_contextual_pick_value(pick, context_a, league) for pick in b_picks)
        - sum(_contextual_player_value(player, context_a) for player in a_gives)
        - sum(_contextual_pick_value(pick, context_a, league) for pick in a_picks), 1,
    )
    fit_b = round(
        sum(_contextual_player_value(player, context_b) for player in a_gives)
        + sum(_contextual_pick_value(pick, context_b, league) for pick in a_picks)
        - sum(_contextual_player_value(player, context_b) for player in b_gives)
        - sum(_contextual_pick_value(pick, context_b, league) for pick in b_picks), 1,
    )
    # A balanced offer should sit near the middle of the scale. Market value,
    # roster-window fit, and immediate lineup impact then move it up or down.
    # The previous baseline of 15 made ordinary fair trades look insulting and
    # allowed recommendation quality to become disconnected from partner fit.
    opponent_market_edge = (value_a - value_b) / max(value_a, value_b, 1) * 100
    opponent_fit_edge = fit_b / max(team_b.total_value, 1) * 100
    opponent_lineup = max(-6.0, min(6.0, impact_b.points_gained))
    tendency = league.manager_tendencies.get(team_b.team_id, {})
    activity_bonus = min(8.0, tendency.get("trades", 0) * 1.5)
    acquired_positions = [tendency.get(f"{player.position.lower()}_acquired", 0) for player in a_gives]
    preference_bonus = min(5.0, sum(acquired_positions) / max(len(acquired_positions), 1) * 1.25) if acquired_positions else 0.0
    if a_picks and tendency.get("picks_acquired", 0) > 0:
        preference_bonus += min(3.0, tendency["picks_acquired"])
    journal_resolved = float(tendency.get("journal_resolved", 0))
    journal_accepted = float(tendency.get("journal_accepted", 0))
    # Beta(2, 2) shrinkage prevents a tiny journal sample from dominating.
    journal_rate = (journal_accepted + 2) / (journal_resolved + 4)
    journal_weight = min(16.0, journal_resolved * 3.0)
    journal_bonus = (journal_rate - .5) * journal_weight
    journal_bonus -= min(6.0, float(tendency.get("journal_partner_reject_feedback", 0)) * 1.5)
    acceptance = round(max(0, min(100, 50 + opponent_market_edge + opponent_fit_edge * 2 + opponent_lineup * 2 + activity_bonus + preference_bonus + journal_bonus)))
    if abs(fairness) <= 8:
        verdict = "Fair market value"
    elif fairness > 8:
        verdict = f"Favors {team_a.team_name}"
    else:
        verdict = f"Favors {team_b.team_name}"
    outcome_odds = _trade_outcome_probabilities(team_a, team_b, a_gives, b_gives, league) if model_playoffs else (None, None, None, None)
    return TradeResult(
        value_a, value_b, difference, fairness, impact_a, impact_b, verdict, fit_a, fit_b, acceptance,
        *outcome_odds,
    )


def explain_trade(
    team: Roster,
    given: list[Player],
    received: list[Player],
    result: TradeResult,
    context: TeamContext,
) -> TradeNarrative:
    impact = result.lineup_a
    incoming_positions = sorted({player.position for player in received})
    outgoing_positions = sorted({player.position for player in given})
    new_starters = ", ".join(impact.new_starters)
    displaced = ", ".join(impact.displaced_starters)
    reasons: list[str] = []
    if new_starters:
        verb = "enters" if len(impact.new_starters) == 1 else "enter"
        starter_note = f"{new_starters} {verb} your optimized lineup"
        if displaced:
            starter_note += f", displacing {displaced}"
        reasons.append(starter_note + ".")
    elif received:
        reasons.append("The incoming players do not currently change your optimized starters.")
    if incoming_positions and outgoing_positions:
        shared = sorted(set(incoming_positions) & set(outgoing_positions))
        added = sorted(set(incoming_positions) - set(outgoing_positions))
        if shared and added:
            reasons.append(f"The return replaces outgoing {'/'.join(shared)} value while adding {'/'.join(added)} help at another position.")
        elif added:
            reasons.append(f"You convert {'/'.join(outgoing_positions)} value into help at {'/'.join(added)}.")
    if impact.points_gained >= 1:
        reasons.append(f"The optimized lineup improves by {impact.points_gained:.1f} projected PPG.")
    elif impact.points_gained <= -1:
        reasons.append(f"The optimized lineup declines by {abs(impact.points_gained):.1f} projected PPG.")
    else:
        reasons.append("The current optimized lineup is essentially unchanged.")
    if impact.depth_change >= 5:
        reasons.append(f"Roster resilience improves from {impact.before_resilience} to {impact.after_resilience}.")
    elif impact.depth_change <= -5:
        reasons.append(f"Roster resilience falls from {impact.before_resilience} to {impact.after_resilience}.")
    if result.fairness > 5:
        reasons.append("The market-value side of the deal favors you.")
    elif result.fairness < -5:
        reasons.append("You pay a market premium for the roster improvement.")

    if impact.points_gained < -1 or (impact.depth_change < -10 and context.window in {"Win Now", "Competing"}):
        label = "Poor roster fit"
    elif impact.coverage_warnings:
        label = "Useful idea with roster risk"
    elif impact.received_player_starts and impact.points_gained >= 0:
        label = "Strategic roster fit"
    elif result.fairness > 8:
        label = "Market win with limited lineup benefit"
    else:
        label = "Mostly lateral move"

    if impact.coverage_warnings:
        risk = impact.coverage_warnings[0]
    elif impact.depth_change < 0:
        risk = "The package reduces roster resilience even if the starting lineup improves."
    elif result.acceptance_score < 45:
        risk = "The partner-fit model suggests the other manager may need a different secondary asset."
    elif not impact.received_player_starts:
        risk = "The return does not currently improve your starting lineup."
    else:
        risk = "The primary uncertainty is whether projections and player availability hold."
    summary = (
        f"This trade fits a {context.window.lower()} plan because it improves a starting spot without an excessive roster sacrifice."
        if label == "Strategic roster fit"
        else f"This trade is best viewed as a {label.lower()}, not just a market-value comparison."
    )
    return TradeNarrative(label, summary, tuple(reasons), risk)
