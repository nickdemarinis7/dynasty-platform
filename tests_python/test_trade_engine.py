import unittest
from dataclasses import replace

from python_app.analytics import build_contexts, evaluate_trade, explain_trade, package_value
from python_app.counteroffers import generate_counteroffers
from python_app.models import DraftPick, League, Player, Roster
from python_app.recommendations import _confidence, _depth_score, _passes_review_gates, _reliable_depth_target, generate_recommendations


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

    def test_package_value_applies_consolidation_discount(self) -> None:
        self.assertLess(package_value([self.a["rb"], self.a["wr"]]), self.a["rb"].value + self.a["wr"].value)

    def test_equal_value_exchange_stays_near_market_neutral(self) -> None:
        left = replace(self.a["rb"], value=50)
        result = evaluate_trade(self.team_a, self.team_b, [left], [self.b["rb"]], self.league)
        self.assertAlmostEqual(result.fairness, 0, delta=0.1)

    def test_review_gate_can_surface_safe_lateral_starter_idea(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["bench"]], [self.b["bench"]], self.league)
        reviewable = replace(
            result,
            acceptance_score=40,
            fairness=4,
            lineup_a=replace(result.lineup_a, received_player_starts=True, points_gained=0, depth_change=0, after_resilience=60),
        )
        context = build_contexts(self.league)[self.team_a.team_id]
        self.assertTrue(_passes_review_gates(reviewable, context))

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

    def test_reusing_contexts_does_not_change_evaluation(self) -> None:
        normal = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["wr"]], self.league)
        reused = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["wr"]], self.league, contexts=build_contexts(self.league))
        self.assertEqual(normal, reused)

    def test_manager_history_adjustment_is_bounded(self) -> None:
        baseline = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["rb"]], self.league)
        noisy = replace(self.league, manager_tendencies={"2": {"trades": 1000, "rb_acquired": 1000, "picks_acquired": 1000}})
        adjusted = evaluate_trade(self.team_a, self.team_b, [self.a["rb"]], [self.b["rb"]], noisy)
        self.assertLessEqual(adjusted.acceptance_score - baseline.acceptance_score, 16)

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
        ideas = generate_recommendations(league, include_low_confidence=True)
        self.assertFalse(any(ordinary in idea.receive_players and any(pick.round == 1 for pick in idea.send_picks) for idea in ideas))

    def test_first_round_pick_requires_material_lineup_return(self) -> None:
        ideas = generate_recommendations(self.league, include_low_confidence=True)
        for idea in ideas:
            if any(pick.round == 1 for pick in idea.send_picks):
                self.assertTrue(
                    idea.evaluation.lineup_a.points_gained >= 3.5
                    or (idea.evaluation.lineup_a.playoff_points_gained or 0) >= 5
                )

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
        pick = DraftPick(2028, 2, "1", "1", 15)
        mine = Roster("1", "Mine", "Me", mine_players, (pick,), wins=8, losses=1, points_for=1100)
        partner = Roster("2", "Partner", "Them", partner_players, wins=3, losses=6, points_for=850)
        points = {"mq": 20, "mr": 14, "mw": 13, "mt": 9, "pq": 18, "pr": 13, "pw": 12, "pt": 8, "reserve": 8}
        league = League("depth", "Depth", "2026", "dynasty", 2, False, False, "half_ppr", (("QB", 1), ("RB", 1), ("WR", 1), ("TE", 1)), "1", (mine, partner), "live", weekly_points=points)
        ideas = generate_recommendations(league, include_low_confidence=True)
        depth_ideas = [idea for idea in ideas if idea.kind == "DEPTH"]
        self.assertTrue(depth_ideas)
        self.assertTrue(any(reserve in idea.receive_players and pick in idea.send_picks for idea in depth_ideas))
        self.assertTrue(all(idea.evaluation.lineup_a.after_resilience > idea.evaluation.lineup_a.before_resilience for idea in depth_ideas))

    def test_depth_ranking_prioritizes_resilience_over_partner_fit(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.a["bench"]], [self.b["bench"]], self.league)
        safer = replace(result, lineup_a=replace(result.lineup_a, depth_change=12, playoff_points_gained=4), acceptance_score=50)
        easier = replace(result, lineup_a=replace(result.lineup_a, depth_change=6, playoff_points_gained=1), acceptance_score=80)
        self.assertGreater(_depth_score(safer, 80)[0], _depth_score(easier, 80)[0])

    def test_depth_target_requires_current_or_established_role(self) -> None:
        fringe = Player("fringe", "Fringe RB", "RB", "A", 23, 15)
        no_role = replace(self.league, weekly_points={**self.league.weekly_points, "fringe": 4})
        established = replace(no_role, player_stats={"fringe": {"gp": 5, "rush_att": 50, "rush_yd": 250, "rush_td": 2}})
        self.assertFalse(_reliable_depth_target(fringe, no_role))
        self.assertTrue(_reliable_depth_target(fringe, established))

    def test_every_returned_recommendation_has_minimum_quality_score(self) -> None:
        ideas = generate_recommendations(self.league, include_low_confidence=True)
        self.assertTrue(all(idea.score >= 55 for idea in ideas))
        self.assertTrue(all(idea.score >= 60 for idea in generate_recommendations(self.league)))


if __name__ == "__main__":
    unittest.main()
