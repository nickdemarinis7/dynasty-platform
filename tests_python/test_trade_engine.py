import unittest
from dataclasses import replace

from python_app.analytics import active_roster_players, assess_team_trade, build_contexts, evaluate_trade, explain_trade, lineup_impact, package_value, projected_points, replacement_player_value, trade_market_range
from python_app.counteroffers import generate_counteroffers
from python_app.models import DraftPick, League, Player, Roster
from python_app.recommendations import Recommendation, _combined_role_risk, _confidence, _depth_score, _evidence_adjusted_score, _hard_gate_reason, _passes_final_review_value, _passes_qb_asset_safety, _passes_review_gates, _pick_return_packages, _qb_role_risk, _recommendation_tier, _reliable_depth_target, _rental_pick_blocked, _return_packages, _score, _score_range, _signal_role_risk, _target_offer_packages, _team_diagnosis, _usage_role_risk, _waiver_alternative_penalty, diversify_recommendations, generate_multi_step_paths, generate_recommendations, generate_sell_offers, generate_target_offers, timed_generate_recommendations


class TradeEngineRegressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.a = {
            "qb": Player("a-qb", "A QB", "QB", "A", 26, 70),
            "rb": Player("a-rb", "A RB", "RB", "A", 25, 60),
            "wr": Player("a-wr", "A WR", "WR", "A", 25, 45),
            "te": Player("a-te", "A TE", "TE", "A", 26, 35),
            "bench": Player("a-bench", "A Bench", "WR", "A", 24, 20),
        }
        self.b = {
            "qb": Player("b-qb", "B QB", "QB", "B", 27, 65),
            "rb": Player("b-rb", "B RB", "RB", "B", 25, 50),
            "wr": Player("b-wr", "B WR", "WR", "B", 24, 70),
            "te": Player("b-te", "B TE", "TE", "B", 27, 30),
            "bench": Player("b-bench", "B Bench", "RB", "B", 23, 20),
        }
        self.pick_a = DraftPick(2027, 2, "1", "1", 15)
        self.pick_b = DraftPick(2027, 1, "2", "2", 30)
        self.team_a = Roster("1", "Alpha", "A", tuple(self.a.values()), (self.pick_a,), wins=7, losses=2, points_for=1100)
        self.team_b = Roster("2", "Beta", "B", tuple(self.b.values()), (self.pick_b,), wins=4, losses=5, points_for=930)
        weekly = {
            "a-qb": 20, "a-rb": 14, "a-wr": 10, "a-te": 8, "a-bench": 6,
            "b-qb": 19, "b-rb": 11, "b-wr": 17, "b-te": 7, "b-bench": 6,
        }
        self.league = League(
            "league", "Regression", "2026", "dynasty", 2, False, False, "half_ppr",
            (("QB", 1), ("RB", 1), ("WR", 1), ("TE", 1), ("FLEX", 1), ("BN", 4)),
            "1", (self.team_a, self.team_b), "live", weekly_points=weekly,
            playoff_weekly_points={15: weekly, 16: weekly},
        )

    def test_package_value_preserves_provider_market_values(self) -> None:
        self.assertEqual(package_value([self.a["rb"], self.a["wr"]]), self.a["rb"].value + self.a["wr"].value)

    def test_ir_player_remains_available_as_a_trade_asset(self) -> None:
        ir_asset = replace(self.a["wr"], id="ir-asset", value=50, injury_status="IR")
        mine = replace(self.team_a, players=(*self.team_a.players, ir_asset), reserve_player_ids=(ir_asset.id,))
        league = replace(self.league, rosters=(mine, self.team_b))
        packages = _target_offer_packages(50, mine, self.team_b, league, build_contexts(league))
        self.assertTrue(any(ir_asset in players for players, _ in packages))
        self.assertNotIn(ir_asset, active_roster_players(mine))

    def test_uneven_player_trade_prices_the_open_roster_spot(self) -> None:
        outgoing = [replace(self.a["rb"], value=40), replace(self.a["wr"], value=20)]
        incoming = [replace(self.b["wr"], value=60)]
        result = evaluate_trade(self.team_a, self.team_b, outgoing, incoming, self.league)
        self.assertEqual(result.team_a_gives, 60)
        self.assertEqual(result.team_b_gives, round(60 + replacement_player_value(self.league), 1))
        self.assertGreater(result.fairness, 0)

    def test_equal_value_exchange_stays_near_market_neutral(self) -> None:
        left = replace(self.a["rb"], value=50)
        result = evaluate_trade(self.team_a, self.team_b, [left], [self.b["rb"]], self.league)
        self.assertAlmostEqual(result.fairness, 0, delta=0.1)

    def test_bye_week_player_does_not_fall_back_to_recent_scoring(self) -> None:
        player = self.a["wr"]
        league = replace(
            self.league,
            current_week=8,
            weekly_points={},
            weekly_player_stats={7: {player.id: {"rec": 8, "rec_yd": 100, "rec_td": 1}}},
            player_signals={player.id: {"bye_week": 8}},
        )
        self.assertEqual(projected_points(player, league), 0)

    def test_market_range_contains_base_trade_fairness(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["wr"]], self.league)
        value_range = trade_market_range([self.a["rb"]], [self.b["wr"]], self.league)
        self.assertAlmostEqual(value_range.base_fairness, result.fairness, delta=.1)
        self.assertLess(value_range.downside_fairness, value_range.base_fairness)
        self.assertGreater(value_range.upside_fairness, value_range.base_fairness)

    def test_depth_trade_is_penalized_when_waiver_pool_has_similar_production(self) -> None:
        target = replace(self.b["rb"], id="target", value=20)
        free = replace(self.b["bench"], id="free", value=8)
        weekly = {**self.league.weekly_points, target.id: 10, free.id: 9}
        league = replace(self.league, weekly_points=weekly, free_agents=(free,))
        penalty, warning = _waiver_alternative_penalty(target, league)
        self.assertEqual(penalty, 20)
        self.assertIn(free.name, warning or "")

    def test_existing_coverage_problem_is_not_attributed_to_unchanged_trade(self) -> None:
        impact = lineup_impact(self.team_a, [], [], self.league)
        self.assertFalse(impact.introduced_coverage_warnings)
        self.assertEqual(impact.existing_coverage_warnings, impact.coverage_warnings)

    def test_removing_last_playable_backup_is_attributed_to_trade(self) -> None:
        backup = Player("a-wr-backup", "A WR Backup", "WR", "A", 24, 16)
        roster = replace(self.team_a, players=(*self.team_a.players, backup))
        league = replace(
            self.league,
            rosters=(roster, self.team_b),
            weekly_points={**self.league.weekly_points, backup.id: 5},
        )
        impact = lineup_impact(roster, [backup], [], league)
        self.assertTrue(any(warning.startswith("WR:") for warning in impact.introduced_coverage_warnings))

    def test_review_gate_can_surface_safe_lateral_starter_idea(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["bench"]], [self.b["bench"]], self.league)
        reviewable = replace(
            result,
            acceptance_score=50,
            fairness=4,
            lineup_a=replace(result.lineup_a, received_player_starts=True, points_gained=0, depth_change=0, after_resilience=60),
        )
        context = build_contexts(self.league)[self.team_a.team_id]
        self.assertTrue(_passes_review_gates(reviewable, context))

    def test_review_gate_rejects_dynasty_qb_downgrade_for_small_lineup_gain(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["qb"]], [self.b["bench"]], self.league)
        reviewable = replace(
            result,
            acceptance_score=50,
            fairness=3,
            lineup_a=replace(result.lineup_a, received_player_starts=True, points_gained=5, depth_change=0, after_resilience=60),
        )
        context = build_contexts(self.league)[self.team_a.team_id]
        self.assertFalse(_passes_review_gates(reviewable, context, [self.a["qb"]], [self.b["bench"]], self.league))

    def test_final_qb_safety_applies_even_when_other_quality_gates_pass(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["qb"], self.a["bench"]], [self.b["qb"], self.b["wr"]], self.league)
        superficially_strong = replace(
            result,
            lineup_a=replace(result.lineup_a, points_gained=2, critical_positions=()),
        )
        self.assertFalse(_passes_qb_asset_safety(
            superficially_strong,
            [self.a["qb"], self.a["bench"]],
            [self.b["qb"], self.b["wr"]],
            self.league,
        ))

    def test_review_candidate_requires_material_current_or_playoff_gain(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["bench"]], [self.b["bench"]], self.league)
        churn = replace(
            result,
            lineup_a=replace(
                result.lineup_a,
                points_gained=.4,
                playoff_points_gained=3.6,
                depth_change=0,
                critical_positions=(),
                after_resilience=65,
            ),
        )
        self.assertFalse(_passes_final_review_value(churn))
        self.assertTrue(_passes_final_review_value(replace(
            churn,
            lineup_a=replace(churn.lineup_a, playoff_points_gained=4.0),
        )))

    def test_trade_narrative_explains_positional_conversion(self) -> None:
        weak_qb = Player("weak-qb", "Weak QB", "QB", "A", 27, 10)
        outgoing_rb = Player("out-rb", "Outgoing RB", "RB", "A", 25, 78)
        incoming_qb = Player("in-qb", "Incoming QB", "QB", "B", 26, 9)
        incoming_rb = Player("in-rb", "Incoming RB", "RB", "B", 24, 97)
        mine = Roster("1", "Mine", "Me", (weak_qb, outgoing_rb), wins=6, losses=1, points_for=800)
        other = Roster("2", "Other", "Them", (incoming_qb, incoming_rb), wins=3, losses=4, points_for=650)
        weekly = {"weak-qb": 10, "out-rb": 12, "in-qb": 16, "in-rb": 14}
        league = League(
            "narrative", "Narrative", "2026", "dynasty", 2, False, False, "half_ppr",
            (("QB", 1), ("RB", 1)), "1", (mine, other), "live", weekly_points=weekly,
        )
        contexts = build_contexts(league)
        result = evaluate_trade(mine, other, [outgoing_rb], [incoming_qb, incoming_rb], league, contexts=contexts)
        narrative = explain_trade(mine, [outgoing_rb], [incoming_qb, incoming_rb], result, contexts[mine.team_id])
        combined = " ".join(narrative.reasons)
        self.assertIn("Incoming QB, Incoming RB enter", combined)
        self.assertIn("replaces outgoing RB value while adding QB", combined)
        self.assertEqual(narrative.label, "Useful idea with roster risk")

    def test_team_assessment_calls_playoff_gain_with_depth_risk_conditional(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["wr"]], [self.b["wr"]], self.league)
        result = replace(result, lineup_a=replace(
            result.lineup_a,
            points_gained=.2,
            playoff_points_gained=2.4,
            depth_change=-3,
            coverage_warnings=("WR: no reliable replacement",),
        ))
        assessment = assess_team_trade(result)
        self.assertEqual(assessment.label, "Conditional upgrade")
        self.assertEqual(assessment.current_label, "Neutral")
        self.assertEqual(assessment.playoff_label, "Positive")
        self.assertEqual(assessment.depth_label, "Negative")

    def test_team_assessment_rejects_lateral_trade_that_weakens_depth(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["wr"]], [self.b["wr"]], self.league)
        result = replace(result, lineup_a=replace(
            result.lineup_a,
            points_gained=.1,
            playoff_points_gained=.4,
            depth_change=-8,
            coverage_warnings=(),
        ))
        assessment = assess_team_trade(result)
        self.assertEqual(assessment.label, "No clear improvement")
        self.assertIn("gets worse", assessment.action)

    def test_pick_changes_market_value_but_not_lineup_directly(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["wr"]], [self.b["rb"]], self.league, [], [self.pick_b])
        without_pick = evaluate_trade(self.team_a, self.team_b, [self.a["wr"]], [self.b["rb"]], self.league)
        self.assertGreater(result.difference_for_a, without_pick.difference_for_a)
        self.assertEqual(result.lineup_a.points_gained, without_pick.lineup_a.points_gained)

    def test_playoff_impact_can_disagree_with_current_week(self) -> None:
        playoff = dict(self.league.weekly_points)
        playoff["a-wr"] = 14
        playoff["b-wr"] = 7
        league = replace(self.league, playoff_weekly_points={15: playoff, 16: playoff})
        result = evaluate_trade(self.team_a, self.team_b, [self.a["wr"]], [self.b["wr"]], league)
        self.assertGreater(result.lineup_a.points_gained, 0)
        self.assertLess(result.lineup_a.playoff_points_gained, 0)

    def test_remaining_season_impact_averages_available_regular_weeks(self) -> None:
        week_11 = dict(self.league.weekly_points)
        week_12 = dict(self.league.weekly_points)
        week_11.update({"a-wr": 8, "b-wr": 18})
        week_12.update({"a-wr": 12, "b-wr": 16})
        league = replace(self.league, regular_season_weekly_points={11: week_11, 12: week_12})
        result = evaluate_trade(self.team_a, self.team_b, [self.a["wr"]], [self.b["wr"]], league)
        self.assertEqual(result.lineup_a.remaining_season_weeks_modeled, (11, 12))
        self.assertGreater(result.lineup_a.remaining_season_points_gained, 0)

    def test_remaining_season_is_unavailable_when_only_current_week_exists(self) -> None:
        league = replace(
            self.league,
            current_week=10,
            regular_season_weekly_points={10: self.league.weekly_points},
        )
        result = evaluate_trade(self.team_a, self.team_b, [self.a["wr"]], [self.b["wr"]], league)
        self.assertIsNone(result.lineup_a.remaining_season_points_gained)
        self.assertEqual(result.lineup_a.remaining_season_weeks_modeled, ())

    def test_reusing_contexts_does_not_change_evaluation(self) -> None:
        normal = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["wr"]], self.league)
        reused = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["wr"]], self.league, contexts=build_contexts(self.league))
        self.assertEqual(normal, reused)

    def test_manager_history_adjustment_is_bounded(self) -> None:
        baseline = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["rb"]], self.league)
        noisy = replace(self.league, manager_tendencies={"2": {"trades": 1000, "rb_acquired": 1000, "picks_acquired": 1000}})
        adjusted = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["rb"]], noisy)
        self.assertLessEqual(adjusted.acceptance_score - baseline.acceptance_score, 16)

    def test_journal_partner_learning_is_directional_and_shrunk(self) -> None:
        baseline = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["rb"]], self.league)
        receptive = replace(self.league, manager_tendencies={"2": {"journal_resolved": 6, "journal_accepted": 6}})
        resistant = replace(self.league, manager_tendencies={"2": {
            "journal_resolved": 6, "journal_accepted": 0, "journal_partner_reject_feedback": 2,
        }})
        receptive_score = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["rb"]], receptive).acceptance_score
        resistant_score = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["rb"]], resistant).acceptance_score
        self.assertGreater(receptive_score, baseline.acceptance_score)
        self.assertLess(resistant_score, baseline.acceptance_score)
        self.assertLessEqual(receptive_score - baseline.acceptance_score, 8)
        self.assertLessEqual(baseline.acceptance_score - resistant_score, 11)

    def test_sell_seeker_keeps_selected_player_in_every_outgoing_package(self) -> None:
        from tests_python.recommendation_audit import build_audit_league
        league = build_audit_league()
        offers, _ = generate_sell_offers(league, "waddle")
        self.assertTrue(offers)
        self.assertTrue(all([player.id for player in offer.send_players] == ["waddle"] for offer in offers))
        self.assertEqual(len({offer.partner.team_id for offer in offers}), len(offers))

    def test_multi_step_path_requires_intermediary_and_safe_first_move(self) -> None:
        from tests_python.recommendation_audit import build_audit_league
        paths = generate_multi_step_paths(build_audit_league(), "nabers", limit=2)
        self.assertTrue(paths)
        for path in paths:
            self.assertIn(path.intermediary.id, {player.id for player in path.first.receive_players})
            self.assertIn(path.intermediary.id, {player.id for player in path.second.send_players})
            self.assertTrue(path.stop_after_step_one_safe)

    def test_counteroffers_are_deterministic_and_unique(self) -> None:
        first = generate_counteroffers(self.team_a, self.team_b, [self.a["bench"]], [self.b["wr"]], self.league)
        second = generate_counteroffers(self.team_a, self.team_b, [self.a["bench"]], [self.b["wr"]], self.league)
        signature = lambda item: (item.label, tuple(player.id for player in item.team_a_players), tuple(player.id for player in item.team_b_players), item.evaluation.fairness)
        self.assertEqual([signature(item) for item in first], [signature(item) for item in second])
        self.assertEqual(len(first), len({signature(item) for item in first}))

    def test_counteroffers_keep_primary_return_and_clear_quality_gates(self) -> None:
        counters = generate_counteroffers(self.team_a, self.team_b, [self.a["bench"]], [self.b["wr"]], self.league)
        self.assertTrue(counters)
        for counter in counters:
            self.assertIn(self.b["wr"], counter.team_b_players)
            self.assertLessEqual(abs(counter.evaluation.fairness), 18)
            self.assertGreaterEqual(counter.evaluation.lineup_a.points_gained, -1)
            self.assertGreaterEqual(counter.evaluation.lineup_a.depth_change, -12)

    def test_first_round_pick_does_not_buy_an_ordinary_asset(self) -> None:
        ordinary = replace(self.b["wr"], value=50)
        partner = replace(self.team_b, players=tuple(ordinary if player.id == ordinary.id else player for player in self.team_b.players))
        league = replace(self.league, rosters=(self.team_a, partner))
        ideas = generate_recommendations(league, include_low_confidence=True, include_review_candidates=True)
        self.assertFalse(any(ordinary in idea.receive_players and any(pick.round == 1 for pick in idea.send_picks) for idea in ideas))

    def test_first_round_pick_requires_material_lineup_return(self) -> None:
        ideas = generate_recommendations(self.league, include_low_confidence=True)
        for idea in ideas:
            if any(pick.round == 1 for pick in idea.send_picks):
                self.assertTrue(
                    idea.evaluation.lineup_a.points_gained >= 3.5
                    or (idea.evaluation.lineup_a.playoff_points_gained or 0) >= 5
                )

    def test_return_search_includes_balancing_assets_without_replacing_primary_target(self) -> None:
        later_pick = DraftPick(2028, 2, "2", "2", 12)
        partner = replace(self.team_b, draft_picks=(self.pick_b, later_pick))
        packages = _return_packages(self.b["wr"], partner, self.league)
        self.assertTrue(any(later_pick in picks for _, picks, _ in packages))
        self.assertTrue(any(len(players) == 2 for players, _, _ in packages))
        self.assertTrue(all(players[0] == self.b["wr"] for players, _, _ in packages))

    def test_rebuilding_sale_can_return_two_later_picks(self) -> None:
        veteran = replace(self.a["wr"], value=30, age=31)
        first = DraftPick(2027, 2, "2", "2", 16)
        second = DraftPick(2028, 2, "2", "2", 16)
        partner = replace(self.team_b, draft_picks=(first, second))
        packages = _pick_return_packages(veteran, partner, self.league)
        self.assertIn((first, second), packages)
        self.assertTrue(all(1 <= len(package) <= 2 for package in packages))

    def test_actionable_recommendations_do_not_exceed_overpay_gate(self) -> None:
        ideas = generate_recommendations(self.league, include_low_confidence=True)
        self.assertTrue(all(idea.evaluation.fairness >= -12 for idea in ideas))
        self.assertTrue(all(idea.evaluation.fairness >= -8 for idea in ideas if any(pick.round == 1 for pick in idea.send_picks)))

    def test_missing_projection_and_history_evidence_is_d_confidence(self) -> None:
        league = replace(self.league, weekly_points={}, playoff_weekly_points={})
        context = build_contexts(league)[self.team_a.team_id]
        grade, reasons = _confidence(league, context, self.team_b, (self.a["rb"], self.b["wr"]))
        self.assertEqual(grade, "D")
        self.assertTrue(any("projections" in reason.lower() for reason in reasons))

    def test_contender_does_not_sell_producer_for_future_pick(self) -> None:
        aging = replace(self.a["wr"], age=31)
        contender = replace(self.team_a, players=tuple(aging if player.id == aging.id else player for player in self.team_a.players))
        league = replace(self.league, rosters=(contender, self.team_b))
        ideas = generate_recommendations(league, include_low_confidence=True)
        self.assertFalse(any(idea.kind == "SELL" and aging in idea.send_players for idea in ideas))

    def test_superflex_qb_is_not_moved_for_marginal_non_qb_upgrade(self) -> None:
        marginal = replace(self.b["wr"], value=65)
        partner = replace(self.team_b, players=tuple(marginal if player.id == marginal.id else player for player in self.team_b.players))
        league = replace(self.league, rosters=(self.team_a, partner))
        ideas = generate_recommendations(league, include_low_confidence=True)
        self.assertFalse(any(any(player.position == "QB" for player in idea.send_players) and marginal in idea.receive_players for idea in ideas))

    def test_thin_contender_can_buy_playable_depth_with_later_pick(self) -> None:
        mine_players = (
            Player("mq", "Mine QB", "QB", "A", 27, 60), Player("mr", "Mine RB", "RB", "A", 25, 55),
            Player("mw", "Mine WR", "WR", "A", 25, 50), Player("mt", "Mine TE", "TE", "A", 26, 40),
        )
        reserve = Player("reserve", "Reserve RB", "RB", "B", 24, 15)
        partner_players = (
            Player("pq", "Partner QB", "QB", "B", 27, 55), Player("pr", "Partner RB", "RB", "B", 25, 50),
            Player("pw", "Partner WR", "WR", "B", 25, 45), Player("pt", "Partner TE", "TE", "B", 26, 35), reserve,
        )
        pick = DraftPick(2028, 2, "1", "1", 11)
        mine = Roster("1", "Mine", "Me", mine_players, (pick,), wins=8, losses=1, points_for=1100)
        partner = Roster("2", "Partner", "Them", partner_players, wins=3, losses=6, points_for=850)
        points = {"mq": 20, "mr": 14, "mw": 13, "mt": 9, "pq": 18, "pr": 13, "pw": 12, "pt": 8, "reserve": 8}
        league = League("depth", "Depth", "2026", "dynasty", 2, False, False, "half_ppr", (("QB", 1), ("RB", 1), ("WR", 1), ("TE", 1)), "1", (mine, partner), "live", weekly_points=points)
        ideas = generate_recommendations(league, include_low_confidence=True, include_review_candidates=True)
        depth_ideas = [idea for idea in ideas if idea.kind == "DEPTH"]
        self.assertTrue(depth_ideas)
        self.assertTrue(any(reserve in idea.receive_players and pick in idea.send_picks for idea in depth_ideas))
        self.assertTrue(all(idea.evaluation.lineup_a.after_resilience > idea.evaluation.lineup_a.before_resilience for idea in depth_ideas))

    def test_depth_ranking_prioritizes_resilience_over_partner_fit(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["bench"]], [self.b["bench"]], self.league)
        safer = replace(result, lineup_a=replace(result.lineup_a, depth_change=12, playoff_points_gained=4), acceptance_score=50)
        easier = replace(result, lineup_a=replace(result.lineup_a, depth_change=6, playoff_points_gained=1), acceptance_score=80)
        self.assertGreater(_depth_score(safer, 80)[0], _depth_score(easier, 80)[0])

    def test_qb_rental_costs_more_team_value_than_young_depth(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [], [self.b["qb"]], self.league, [self.pick_a])
        insurance = replace(
            result,
            lineup_a=replace(result.lineup_a, points_gained=.5, playoff_points_gained=1, depth_change=12),
            fairness=0,
            acceptance_score=55,
        )
        young_qb = replace(self.b["qb"], age=25)
        retiring_qb = replace(self.b["qb"], age=41)
        young_score, _ = _depth_score(insurance, 70, young_qb, self.pick_a)
        rental_score, breakdown = _depth_score(insurance, 70, retiring_qb, self.pick_a)
        self.assertGreater(young_score, rental_score)
        self.assertGreaterEqual(young_score - rental_score, 20)
        self.assertTrue(any(label == "Short-horizon cost" and value < 0 for label, value in breakdown))

    def test_second_for_retirement_risk_qb_requires_aggressive_title_leverage(self) -> None:
        retiring_qb = replace(self.b["qb"], age=41)
        result = evaluate_trade(self.team_a, self.team_b, [], [retiring_qb], self.league, [self.pick_a])
        title_push = replace(
            result,
            lineup_a=replace(result.lineup_a, points_gained=3.5, playoff_points_gained=5),
        )
        self.assertTrue(_rental_pick_blocked(retiring_qb, self.pick_a, "Balanced", title_push))
        self.assertFalse(_rental_pick_blocked(retiring_qb, self.pick_a, "Aggressive", title_push))
        weak_push = replace(title_push, lineup_a=replace(title_push.lineup_a, points_gained=1, playoff_points_gained=2))
        self.assertTrue(_rental_pick_blocked(retiring_qb, self.pick_a, "Aggressive", weak_push))

    def test_bridge_qb_with_valuable_young_teammate_has_severe_role_risk(self) -> None:
        bridge = Player("bridge", "Bridge QB", "QB", "LV", 38, 22)
        rookie = Player("rookie", "First Pick Rookie", "QB", "LV", 22, 55)
        partner = replace(self.team_b, players=(*self.team_b.players, bridge, rookie))
        league = replace(self.league, rosters=(self.team_a, partner))
        penalty, warning = _qb_role_risk(bridge, league)
        self.assertGreaterEqual(penalty, 20)
        self.assertIn(rookie.name, warning or "")
        result = evaluate_trade(self.team_a, partner, [], [bridge], league, [self.pick_a])
        self.assertTrue(_rental_pick_blocked(bridge, self.pick_a, "Balanced", result, penalty))

    def test_provider_qb2_depth_chart_status_is_severe_role_risk(self) -> None:
        listed_backup = replace(self.b["qb"], age=26)
        league = replace(self.league, player_roles={listed_backup.id: {"depth_chart_order": 2}})
        penalty, warning = _qb_role_risk(listed_backup, league)
        self.assertGreaterEqual(penalty, 20)
        self.assertIn("QB2", warning)

    def test_inactive_provider_status_is_a_severe_role_signal(self) -> None:
        target = self.b["qb"]
        league = replace(self.league, player_signals={target.id: {"status": "Inactive"}})
        penalty, warning = _signal_role_risk(target, league)
        self.assertEqual(penalty, 30)
        self.assertIn("INACTIVE", warning or "")

    def test_practice_and_drop_signals_are_bounded_but_visible(self) -> None:
        target = replace(self.b["wr"], injury_status="Questionable")
        dnp = replace(self.league, player_signals={target.id: {
            "practice_participation": "Did Not Participate", "practice_description": "hamstring",
        }})
        penalty, warning = _signal_role_risk(target, dnp)
        self.assertEqual(penalty, 11)
        self.assertIn("hamstring", warning or "")
        trend = replace(self.league, player_signals={target.id: {
            "trending_drops_24h": 1500, "trending_adds_24h": 100, "trend_window_hours": 24,
        }})
        trend_penalty, trend_warning = _signal_role_risk(target, trend)
        self.assertEqual(trend_penalty, 8)
        self.assertIn("1,500", trend_warning or "")
        invalid_window = replace(self.league, player_signals={target.id: {
            "trending_drops_24h": 5000, "trending_adds_24h": 0, "trend_window_hours": 168,
        }})
        self.assertEqual(_signal_role_risk(target, invalid_window), (0.0, None))

    def test_overall_score_is_capped_when_evidence_is_weak(self) -> None:
        self.assertEqual(_evidence_adjusted_score(84, "A")[0], 84)
        self.assertEqual(_evidence_adjusted_score(84, "B")[0], 80)
        self.assertEqual(_evidence_adjusted_score(84, "C")[0], 69)
        self.assertEqual(_evidence_adjusted_score(84, "D")[0], 54)

    def test_balanced_option_requires_neutral_partner_fit(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["wr"]], self.league)
        useful = replace(
            result, acceptance_score=47, fairness=5,
            lineup_a=replace(result.lineup_a, points_gained=4, playoff_points_gained=4, depth_change=0),
        )
        self.assertEqual(_recommendation_tier(useful, 70, "Balanced"), "Exploratory")

    def test_combined_role_risk_uses_strongest_signal_without_stacking_noise(self) -> None:
        target = replace(self.b["qb"], age=26)
        league = replace(
            self.league,
            player_roles={target.id: {"depth_chart_order": 2}},
            player_signals={target.id: {"trending_drops_24h": 2000, "trending_adds_24h": 50, "trend_window_hours": 24}},
        )
        penalty, warnings = _combined_role_risk(target, league)
        self.assertEqual(penalty, 28)
        self.assertEqual(len(warnings), 2)

    def test_recent_opportunity_collapse_detects_teammate_takeover(self) -> None:
        fading = replace(self.b["wr"], id="fading", name="Fading WR", team="NFL")
        rising = replace(self.b["bench"], id="rising", name="Rising WR", position="WR", team="NFL")
        partner = replace(self.team_b, players=(fading, rising, self.b["qb"], self.b["rb"], self.b["te"]))
        weekly_stats = {
            1: {"fading": {"rec_tgt": 10}, "rising": {"rec_tgt": 2}},
            2: {"fading": {"rec_tgt": 9}, "rising": {"rec_tgt": 3}},
            3: {"fading": {"rec_tgt": 10}, "rising": {"rec_tgt": 3}},
            4: {"fading": {"rec_tgt": 3}, "rising": {"rec_tgt": 8}},
            5: {"fading": {"rec_tgt": 2}, "rising": {"rec_tgt": 9}},
        }
        league = replace(self.league, rosters=(self.team_a, partner), weekly_player_stats=weekly_stats)
        penalty, warning = _usage_role_risk(fading, league)
        self.assertGreaterEqual(penalty, 18)
        self.assertIn("Rising WR", warning)

    def test_trade_simulation_rewards_a_material_title_odds_upgrade(self) -> None:
        weak = Player("weak", "Weak QB", "QB", "A", 25, 10)
        elite = Player("elite", "Elite QB", "QB", "B", 25, 80)
        others = [Player(f"q{index}", f"QB {index}", "QB", str(index), 27, 40) for index in (3, 4)]
        rosters = (
            Roster("1", "One", "One", (weak,), wins=4, losses=5, points_for=850),
            Roster("2", "Two", "Two", (elite,), wins=5, losses=4, points_for=950),
            Roster("3", "Three", "Three", (others[0],), wins=5, losses=4, points_for=930),
            Roster("4", "Four", "Four", (others[1],), wins=4, losses=5, points_for=880),
        )
        league = League(
            "outcomes", "Outcomes", "2026", "redraft", 4, False, False, "half_ppr", (("QB", 1),),
            "1", rosters, "live", current_week=10,
            weekly_points={"weak": 5, "elite": 30, "q3": 18, "q4": 17},
            playoff_weekly_points={15: {"weak": 5, "elite": 30, "q3": 18, "q4": 17}},
            remaining_matchups=((10, "1", "2"), (10, "3", "4"), (11, "1", "3"), (11, "2", "4")),
            playoff_teams=2,
        )
        result = evaluate_trade(rosters[0], rosters[1], [weak], [elite], league)
        alternative = evaluate_trade(rosters[0], rosters[2], [weak], [others[0]], league)
        self.assertEqual(result.playoff_probability_before, alternative.playoff_probability_before)
        self.assertEqual(result.championship_probability_before, alternative.championship_probability_before)
        self.assertGreater(result.playoff_probability_after, result.playoff_probability_before)
        self.assertGreater(result.championship_probability_after, result.championship_probability_before)

    def test_depth_target_requires_current_or_established_role(self) -> None:
        fringe = Player("fringe", "Fringe RB", "RB", "A", 23, 15)
        no_role = replace(self.league, weekly_points={**self.league.weekly_points, "fringe": 4})
        established = replace(no_role, player_stats={"fringe": {"gp": 5, "rush_att": 50, "rush_yd": 250, "rush_td": 2}})
        self.assertFalse(_reliable_depth_target(fringe, no_role))
        self.assertTrue(_reliable_depth_target(fringe, established))

    def test_every_returned_recommendation_has_minimum_quality_score(self) -> None:
        ideas = generate_recommendations(self.league, include_low_confidence=True)
        self.assertTrue(all(idea.score >= 55 for idea in ideas))
        self.assertTrue(all(
            _passes_qb_asset_safety(idea.evaluation, idea.send_players, idea.receive_players, self.league)
            for idea in ideas
        ))
        self.assertTrue(all(idea.score >= 60 for idea in generate_recommendations(self.league)))

    def test_recommendation_search_reports_work_performed(self) -> None:
        ideas, performance = timed_generate_recommendations(self.league, include_low_confidence=True)
        self.assertEqual(performance.recommendations_returned, len(ideas))
        self.assertGreater(performance.packages_evaluated, 0)
        self.assertLessEqual(performance.full_evaluations, performance.packages_evaluated)
        self.assertGreaterEqual(performance.elapsed_ms, 0)
        self.assertTrue(performance.team_diagnosis)
        self.assertGreater(sum(count for _, count in performance.rejection_counts), 0)

    def test_aggressive_profile_surfaces_upside_with_explicit_depth_cost(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["wr"]], self.league)
        upside = replace(
            result,
            acceptance_score=52,
            fairness=5,
            lineup_a=replace(result.lineup_a, points_gained=2.5, playoff_points_gained=4, depth_change=-15, critical_positions=(), after_resilience=45),
        )
        self.assertEqual(_recommendation_tier(upside, 60, "Aggressive"), "Aggressive upside")
        self.assertEqual(_recommendation_tier(upside, 60, "Conservative"), "Exploratory")
        self.assertIsNone(_hard_gate_reason(upside, [self.a["rb"]], [self.b["wr"]], [], self.league, self.b["wr"]))

    def test_bottom_record_with_top_scoring_is_underperforming_contender(self) -> None:
        context = replace(
            build_contexts(self.league)[self.team_a.team_id],
            record_rank=2,
            points_rank=1,
        )
        self.assertEqual(_team_diagnosis(context, self.league), "Underperforming contender")

    def test_shortlist_does_not_spend_the_same_outgoing_package_twice(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["rb"], self.a["wr"]], [self.b["wr"]], self.league)
        first = Recommendation(
            "BUY", self.team_b, (self.a["rb"], self.a["wr"]), (), (self.b["wr"],), (),
            result, 72, "First use", objective="Starter upgrade",
        )
        second = replace(first, receive_players=(self.b["rb"],), score=68, reason="Second use", objective="Starter plus depth")
        shortlist = diversify_recommendations([first, second], 5)
        self.assertEqual(shortlist, [first])

    def test_player_seeker_anchors_every_offer_to_exact_target(self) -> None:
        offers, performance = generate_target_offers(self.league, self.b["wr"].id)
        self.assertGreater(performance.packages_evaluated, 0)
        self.assertTrue(offers or performance.rejection_counts)
        self.assertTrue(all(self.b["wr"] in offer.receive_players for offer in offers))
        self.assertTrue(all(offer.partner.team_id == self.team_b.team_id for offer in offers))
        self.assertTrue(all(offer.kind == "TARGET" for offer in offers))

    def test_player_seeker_rejects_own_or_unknown_target(self) -> None:
        own_offers, own_performance = generate_target_offers(self.league, self.a["wr"].id)
        missing_offers, missing_performance = generate_target_offers(self.league, "missing")
        self.assertEqual(own_offers, [])
        self.assertEqual(missing_offers, [])
        self.assertEqual(own_performance.rejection_counts, (("Target is not held by another roster", 1),))
        self.assertEqual(missing_performance.rejection_counts, (("Target is not held by another roster", 1),))

    def test_contender_gate_rejects_multiple_unavailable_incoming_players(self) -> None:
        injured_wr = replace(self.b["wr"], injury_status="IR")
        injured_rb = replace(self.b["rb"], injury_status="Out")
        result = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [injured_wr, injured_rb], self.league)
        context = build_contexts(self.league)[self.team_a.team_id]
        self.assertEqual(
            _hard_gate_reason(
                result, [self.a["rb"]], [injured_wr, injured_rb], [], self.league, injured_wr, context,
            ),
            "Multiple unavailable incoming players",
        )

    def test_contender_target_cannot_be_carried_by_secondary_starter(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["qb"], self.b["wr"]], self.league)
        secondary_only = replace(
            result,
            lineup_a=replace(result.lineup_a, received_player_starts=True, new_starters=(self.b["wr"].name,)),
        )
        context = build_contexts(self.league)[self.team_a.team_id]
        self.assertEqual(
            _hard_gate_reason(
                secondary_only, [self.a["rb"]], [self.b["qb"], self.b["wr"]], [],
                self.league, self.b["qb"], context,
            ),
            "Target does not enter starting lineup",
        )

    def test_contender_lineup_leverage_can_outweigh_a_market_overpay(self) -> None:
        base = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["wr"]], self.league)
        context = build_contexts(self.league)[self.team_a.team_id]
        powerhouse = replace(
            base,
            fairness=-12,
            acceptance_score=55,
            lineup_a=replace(base.lineup_a, points_gained=5, playoff_points_gained=6, depth_change=-5, received_player_starts=True),
        )
        churn = replace(
            base,
            fairness=0,
            acceptance_score=55,
            lineup_a=replace(base.lineup_a, points_gained=.2, playoff_points_gained=.5, depth_change=0, received_player_starts=True),
        )
        powerhouse_score, powerhouse_team, powerhouse_market, _ = _score(
            powerhouse, 50, context=context, send_players=[self.a["rb"]], receive_players=[self.b["wr"]],
        )
        churn_score, churn_team, churn_market, _ = _score(
            churn, 50, context=context, send_players=[self.a["rb"]], receive_players=[self.b["wr"]],
        )
        self.assertGreater(powerhouse_score, churn_score)
        self.assertGreater(powerhouse_team, churn_team)
        self.assertLess(powerhouse_market, churn_market)

    def test_recommendation_range_widens_with_weaker_evidence_and_value_disagreement(self) -> None:
        strong = _score_range(70, "A", 72, 68)
        uncertain = _score_range(70, "C", 90, 40)
        self.assertGreater(uncertain[1] - uncertain[0], strong[1] - strong[0])


if __name__ == "__main__":
    unittest.main()
