import unittest
from dataclasses import replace

from python_app.analytics import active_roster_players, build_contexts, calc_fppg, compute_projections, depth_profile, evaluate_trade, lineup_impact, optimize_lineup, projected_points
from python_app.models import DraftPick, League, Player, Roster
from python_app.recommendations import generate_recommendations
from python_app.strategy import build_team_plan
from python_app.waivers import generate_waiver_recommendations
from python_app.counteroffers import generate_counteroffers
from python_app.value_system import balance_label, protected_player_ids, value_profile


class RosterModelTests(unittest.TestCase):
    def test_total_asset_value_includes_draft_capital(self) -> None:
        roster = Roster(
            "1", "A", "A",
            (Player("p", "Player", "WR", "A", 24, 42.75),),
            (DraftPick(2027, 2, "1", "1", 13.25),),
        )
        self.assertEqual(roster.player_value, 42.75)
        self.assertEqual(roster.pick_value, 13.25)
        self.assertEqual(roster.total_asset_value, 56.0)

    def test_value_profiles_expose_tier_and_uncertainty_range(self) -> None:
        players = tuple(Player(str(index), f"P{index}", "WR", "A", 24, value) for index, value in enumerate((5, 10, 20, 40, 80)))
        roster = Roster("1", "A", "A", players)
        league = self._league((roster,))
        profile = value_profile(players[-1], league)
        self.assertEqual(profile.tier, "Cornerstone")
        self.assertLess(profile.low, profile.value)
        self.assertGreater(profile.high, profile.value)

    def test_adjacent_tier_boundaries_do_not_create_range_cliffs(self) -> None:
        players = tuple(Player(str(index), f"P{index}", "WR", "A", 24, float(index + 1)) for index in range(101))
        roster = Roster("1", "A", "A", players)
        league = self._league((roster,))
        lower = value_profile(players[89], league)
        upper = value_profile(players[90], league)
        lower_width = (lower.high - lower.low) / lower.value
        upper_width = (upper.high - upper.low) / upper.value
        self.assertLess(abs(lower_width - upper_width), .01)

    def test_core_protection_is_relative_to_market_not_fixed_scale(self) -> None:
        core = Player("core", "Core", "WR", "A", 24, 57.4)
        second = Player("second", "Second", "RB", "A", 25, 43.2)
        depth = Player("depth", "Depth", "TE", "A", 26, 8.1)
        roster = Roster("1", "A", "A", (core, second, depth))
        league = self._league((roster,))
        protected = protected_player_ids(roster, league)
        self.assertIn(core.id, protected)
        self.assertIn(second.id, protected)
        self.assertNotIn(depth.id, protected)

    def test_market_balance_uses_decision_bands(self) -> None:
        self.assertEqual(balance_label(3.2), "Roughly even")
        self.assertEqual(balance_label(-8.0), "Give a little more")
        self.assertEqual(balance_label(16.0), "Receive meaningfully more")

    def test_roster_metrics_ignore_unknown_ages(self) -> None:
        roster = Roster(
            team_id="1",
            team_name="Test",
            owner_name="Manager",
            players=(
                Player("a", "A", "QB", "BUF", 28, 90),
                Player("b", "B", "WR", "MIN", 0, 80),
            ),
        )
        self.assertEqual(roster.total_value, 170)
        self.assertEqual(roster.starter_value, 170)
        self.assertEqual(roster.average_age, 28)

    def _league(self, rosters: tuple[Roster, ...]) -> League:
        return League("league", "Test", "2026", "dynasty", 2, True, False, "half_ppr", (("QB", 1), ("RB", 1), ("WR", 1), ("TE", 1), ("SUPERFLEX", 1)), "1", rosters, "live")

    def test_optimizer_never_starts_a_player_twice(self) -> None:
        players = tuple(Player(str(index), f"P{index}", position, "X", 25, value) for index, (position, value) in enumerate((("QB", 90), ("QB", 70), ("RB", 60), ("WR", 50), ("TE", 40))))
        roster = Roster("1", "A", "A", players)
        lineup = optimize_lineup(players, self._league((roster,)))
        self.assertEqual(len(lineup.starters), len({player.id for player in lineup.starters}))
        self.assertEqual(len(lineup.starters), 5)

    def test_trade_reports_lineup_upgrade_for_better_starter(self) -> None:
        weak = Player("weak", "Weak RB", "RB", "A", 26, 20)
        strong = Player("strong", "Strong RB", "RB", "B", 25, 90)
        qb_a = Player("qba", "QB A", "QB", "A", 27, 60)
        qb_b = Player("qbb", "QB B", "QB", "B", 27, 60)
        team_a = Roster("1", "A", "A", (qb_a, weak))
        team_b = Roster("2", "B", "B", (qb_b, strong))
        league = replace(
            self._league((team_a, team_b)),
            weekly_points={"qba": 18, "qbb": 18, "weak": 6, "strong": 18},
            playoff_weekly_points={15: {"qba": 18, "qbb": 18, "weak": 5, "strong": 20}, 16: {"qba": 18, "qbb": 18, "weak": 7, "strong": 17}},
        )
        result = evaluate_trade(team_a, team_b, [weak], [strong], league)
        self.assertGreater(result.lineup_a.points_gained, 0)
        self.assertTrue(result.lineup_a.received_player_starts)
        self.assertEqual(result.lineup_a.playoff_weeks_modeled, (15, 16))
        self.assertGreater(result.lineup_a.playoff_points_gained, 0)

    def test_lineup_impact_identifies_internal_replacement_and_depth_loss(self) -> None:
        qb_one = Player("qb1", "QB One", "QB", "A", 26, 70)
        qb_two = Player("qb2", "QB Two", "QB", "A", 27, 60)
        rb_one = Player("rb1", "RB One", "RB", "A", 25, 70)
        rb_two = Player("rb2", "RB Two", "RB", "A", 24, 35)
        receiver = Player("wr", "Receiver", "WR", "A", 25, 50)
        tight_end = Player("te", "Tight End", "TE", "A", 26, 45)
        roster = Roster("1", "A", "A", (qb_one, qb_two, rb_one, rb_two, receiver, tight_end))
        league = replace(
            self._league((roster,)),
            weekly_points={"qb1": 22, "qb2": 18, "rb1": 16, "rb2": 8, "wr": 12, "te": 10},
        )

        impact = lineup_impact(roster, [rb_one], [], league)

        self.assertIn("RB One", impact.outgoing_starters)
        self.assertIn("RB Two", impact.internal_replacements)
        self.assertLess(impact.depth_change, 0)
        self.assertTrue(any(warning.startswith("RB:") for warning in impact.coverage_warnings))

    def test_resilience_detects_thin_roster_and_rewards_playable_backups(self) -> None:
        starters = (
            Player("qb", "QB", "QB", "A", 27, 70), Player("rb", "RB", "RB", "A", 25, 60),
            Player("wr", "WR", "WR", "A", 25, 55), Player("te", "TE", "TE", "A", 26, 45),
        )
        backups = (
            Player("qb2", "QB2", "QB", "A", 29, 25), Player("rb2", "RB2", "RB", "A", 24, 25),
            Player("wr2", "WR2", "WR", "A", 24, 25), Player("te2", "TE2", "TE", "A", 25, 20),
        )
        points = {"qb": 20, "rb": 14, "wr": 13, "te": 10, "qb2": 13, "rb2": 8, "wr2": 8, "te2": 6}
        league = replace(self._league((Roster("1", "A", "A", starters),)), roster_slots=(("QB", 1), ("RB", 1), ("WR", 1), ("TE", 1)), weekly_points=points)
        thin = depth_profile(starters, league)
        stable = depth_profile(starters + backups, league)
        self.assertLess(thin.score, stable.score)
        self.assertEqual(set(thin.critical_positions), {"QB", "RB", "WR", "TE"})
        self.assertFalse(stable.critical_positions)

    def test_taxi_and_reserve_players_do_not_count_as_active_depth(self) -> None:
        starter = Player("starter", "Starter", "RB", "A", 25, 60)
        taxi = Player("taxi", "Taxi RB", "RB", "A", 21, 25)
        reserve = Player("reserve", "Reserve RB", "RB", "A", 26, 30)
        roster = Roster("1", "A", "A", (starter, taxi, reserve), reserve_player_ids=("reserve",), taxi_player_ids=("taxi",))
        self.assertEqual(active_roster_players(roster), (starter,))
        league = replace(self._league((roster,)), roster_slots=(("RB", 1),), weekly_points={"starter": 14, "taxi": 8, "reserve": 9})
        profile = depth_profile(active_roster_players(roster), league)
        self.assertIn("RB", profile.critical_positions)

    def test_market_value_is_never_used_as_projected_points(self) -> None:
        player = Player("elite", "Elite Market Asset", "RB", "A", 24, 100)
        roster = Roster("1", "A", "A", (player,))
        league = self._league((roster,))
        self.assertEqual(projected_points(player, league), 0)

    def test_custom_scoring_settings_drive_fppg(self) -> None:
        quarterback = Player("qb", "Quarterback", "QB", "A", 25, 50)
        roster = Roster("1", "A", "A", (quarterback,))
        league = replace(self._league((roster,)), scoring_settings={"pass_td": 6, "pass_yd": .04, "pass_int": -2})
        self.assertEqual(calc_fppg({"gp": 1, "pass_td": 2, "pass_yd": 250, "pass_int": 1}, quarterback, league), 20)

    def test_draft_pick_changes_market_fairness_without_lineup_points(self) -> None:
        player_a = Player("a", "Player A", "RB", "A", 25, 50)
        player_b = Player("b", "Player B", "WR", "B", 25, 50)
        pick = DraftPick(2027, 1, "2", "2", 30)
        team_a = Roster("1", "A", "A", (player_a,))
        team_b = Roster("2", "B", "B", (player_b,), (pick,))
        league = self._league((team_a, team_b))
        result = evaluate_trade(team_a, team_b, [player_a], [player_b], league, [], [pick])
        self.assertGreater(result.difference_for_a, 0)
        self.assertEqual(result.lineup_a.points_gained, 0)

    def test_even_trade_has_neutral_offer_fit(self) -> None:
        player_a = Player("a", "Player A", "WR", "A", 25, 50)
        player_b = Player("b", "Player B", "WR", "B", 25, 50)
        team_a = Roster("1", "A", "A", (player_a,))
        team_b = Roster("2", "B", "B", (player_b,))
        result = evaluate_trade(team_a, team_b, [player_a], [player_b], self._league((team_a, team_b)))
        self.assertGreaterEqual(result.acceptance_score, 45)
        self.assertLessEqual(result.acceptance_score, 55)

    def test_partner_trade_history_increases_fit_for_familiar_assets(self) -> None:
        player_a = Player("a", "Player A", "WR", "A", 25, 50)
        player_b = Player("b", "Player B", "WR", "B", 25, 50)
        team_a = Roster("1", "A", "A", (player_a,))
        team_b = Roster("2", "B", "B", (player_b,))
        league = self._league((team_a, team_b))
        baseline = evaluate_trade(team_a, team_b, [player_a], [player_b], league)
        active = evaluate_trade(
            team_a,
            team_b,
            [player_a],
            [player_b],
            replace(league, manager_tendencies={"2": {"trades": 4, "wr_acquired": 3, "picks_acquired": 0}}),
        )

        self.assertGreater(active.acceptance_score, baseline.acceptance_score)

    def test_partner_history_cannot_rescue_a_market_overpay(self) -> None:
        mine = Roster("1", "Mine", "Me", (
            Player("qb", "QB", "QB", "A", 26, 60),
            Player("rb", "Expensive RB", "RB", "A", 25, 65),
            Player("te", "TE", "TE", "A", 25, 35),
        ))
        other = Roster("2", "Other", "Them", (
            Player("wr", "Target WR", "WR", "B", 25, 50),
            Player("oqb", "Other QB", "QB", "B", 27, 45),
            Player("orb", "Other RB", "RB", "B", 26, 35),
            Player("ote", "Other TE", "TE", "B", 26, 30),
        ))
        league = replace(
            self._league((mine, other)),
            weekly_points={"qb": 18, "rb": 13, "te": 8, "wr": 14, "oqb": 16, "orb": 8, "ote": 7},
            manager_tendencies={"2": {"trades": 100, "rb_acquired": 100, "picks_acquired": 100}},
        )

        self.assertEqual(generate_recommendations(league, target_position="WR"), [])

    def test_counteroffer_builder_repairs_an_underpay_without_sending_anchor(self) -> None:
        anchor = Player("anchor", "Anchor QB", "QB", "A", 24, 90)
        filler = Player("filler", "Filler WR", "WR", "A", 25, 30)
        running_back = Player("rb", "Starting RB", "RB", "A", 25, 60)
        tight_end = Player("te", "Tight End", "TE", "A", 26, 30)
        mine = Roster("1", "Mine", "Me", (anchor, filler, running_back, tight_end))
        target = Player("target", "Target WR", "WR", "B", 25, 70)
        other = Roster("2", "Other", "Them", (
            target,
            Player("oqb", "Other QB", "QB", "B", 27, 50),
            Player("orb", "Other RB", "RB", "B", 26, 40),
            Player("ote", "Other TE", "TE", "B", 27, 25),
        ))
        league = replace(
            self._league((mine, other)),
            weekly_points={"anchor": 22, "filler": 8, "rb": 14, "te": 8, "target": 16, "oqb": 17, "orb": 10, "ote": 7},
        )

        counters = generate_counteroffers(mine, other, [filler], [target], league)

        self.assertTrue(counters)
        self.assertLessEqual(len(counters), 3)
        self.assertTrue(all(abs(counter.evaluation.fairness) <= 18 for counter in counters))
        self.assertTrue(all(target in counter.team_b_players for counter in counters))
        self.assertTrue(all(anchor not in counter.team_a_players for counter in counters))
        self.assertTrue(all(counter.edits >= 1 for counter in counters))
        self.assertEqual(len({counter.label for counter in counters}), len(counters))

    def test_rebuilder_values_youth_more_than_aging_player(self) -> None:
        young = Player("young", "Young WR", "WR", "A", 21, 50)
        old = Player("old", "Old WR", "WR", "B", 33, 50)
        strong = Roster("1", "Strong", "A", tuple(Player(f"s{i}", f"S{i}", "RB", "A", 29, 90) for i in range(6)))
        rebuild = Roster("2", "Rebuild", "B", (young,))
        league = self._league((strong, rebuild))
        contexts = build_contexts(league)
        self.assertLess(contexts["2"].win_now_weight, contexts["1"].win_now_weight)
        result = evaluate_trade(rebuild, strong, [young], [old], league)
        self.assertLess(result.fit_a, 0)

    def test_fppg_respects_reception_scoring(self) -> None:
        receiver = Player("wr", "Receiver", "WR", "A", 25, 50)
        roster = Roster("1", "A", "A", (receiver,))
        league = self._league((roster,))
        stats = {"gp": 2, "rec": 10, "rec_yd": 100, "rec_td": 1}
        half = calc_fppg(stats, receiver, league)
        full = calc_fppg(stats, receiver, replace(league, scoring="ppr"))
        self.assertEqual(full - half, 2.5)

    def test_weekly_projection_precedes_market_estimate(self) -> None:
        player = Player("p", "Player", "RB", "A", 25, 100)
        roster = Roster("1", "A", "A", (player,))
        league = replace(self._league((roster,)), weekly_points={"p": 7.25})
        self.assertEqual(projected_points(player, league), 7.2)

    def test_out_player_never_uses_healthy_projection_or_average(self) -> None:
        player = Player("out", "Out Player", "WR", "A", 26, 50, "OUT")
        roster = Roster("1", "A", "A", (player,))
        stats = {"out": {"gp": 4, "rec": 24, "rec_yd": 320, "rec_td": 2}}
        league = replace(self._league((roster,)), weekly_points={"out": 15}, player_stats=stats)
        self.assertEqual(projected_points(player, league), 0)

    def test_waiver_assistant_returns_exact_add_drop_upgrade(self) -> None:
        players = (
            Player("qb1", "QB One", "QB", "A", 27, 60),
            Player("qb2", "QB Two", "QB", "A", 28, 50),
            Player("rb", "RB", "RB", "A", 25, 45),
            Player("wr", "Weak WR", "WR", "A", 26, 20),
            Player("te", "TE", "TE", "A", 26, 35),
            Player("bench", "Bench RB", "RB", "A", 27, 5),
        )
        roster = Roster("1", "Mine", "Me", players, waiver_budget_remaining=80, waiver_position=3)
        add = Player("add", "Waiver WR", "WR", "B", 23, 30)
        league = replace(
            self._league((roster,)),
            free_agents=(add,),
            weekly_points={"qb1": 20, "qb2": 17, "rb": 11, "wr": 6, "te": 8, "bench": 3, "add": 14},
        )

        ideas = generate_waiver_recommendations(league)

        self.assertTrue(ideas)
        self.assertEqual(ideas[0].add, add)
        self.assertEqual(ideas[0].drop.name, "Bench RB")
        self.assertGreater(ideas[0].lineup_gain, 0)
        self.assertEqual(ideas[0].category, "STARTER UPGRADE")
        self.assertIsNotNone(ideas[0].suggested_faab)
        self.assertGreater(ideas[0].suggested_faab, 0)
        self.assertIn("80 remaining FAAB", ideas[0].claim_guidance)

    def test_waiver_confidence_requires_role_evidence(self) -> None:
        starters = tuple(
            Player(f"{position}-{index}", f"{position} {index}", position, "A", 26, 40)
            for index, position in enumerate(("QB", "QB", "RB", "WR", "TE"))
        )
        drop = Player("drop", "Drop", "WR", "A", 25, 1)
        roster = Roster("1", "Mine", "Me", starters + (drop,), waiver_budget_remaining=100)
        speculative = Player("spec", "Speculative QB", "QB", "B", 22, 12)
        league = replace(
            self._league((roster,)), free_agents=(speculative,), active_roster_capacity=6,
            weekly_points={"spec": 12}, playoff_weekly_points={15: {"spec": 12}},
        )
        ideas = generate_waiver_recommendations(league)
        self.assertTrue(ideas)
        self.assertIn(ideas[0].confidence, {"C", "D"})
        self.assertTrue(any("role" in item.lower() for item in ideas[0].confidence_reasons))

    def test_waiver_output_names_lineup_displacement(self) -> None:
        weak = Player("weak", "Weak QB", "QB", "A", 28, 5)
        drop = Player("drop", "Drop WR", "WR", "A", 25, 1)
        roster = Roster("1", "Mine", "Me", (weak, drop), waiver_budget_remaining=100)
        upgrade = Player("upgrade", "Upgrade QB", "QB", "B", 30, 20)
        stats = {"upgrade": {"gp": 5, "pass_att": 150}}
        league = replace(
            self._league((roster,)), roster_slots=(("QB", 1), ("BN", 1)), free_agents=(upgrade,),
            active_roster_capacity=2, weekly_points={"weak": 5, "upgrade": 15},
            player_stats=stats, player_teams={"upgrade": "B"},
        )
        ideas = generate_waiver_recommendations(league)
        self.assertTrue(ideas)
        self.assertIn("Enters lineup: Upgrade QB", ideas[0].lineup_change)
        self.assertIn("Displaces: Weak QB", ideas[0].lineup_change)

    def test_waiver_assistant_does_not_drop_ir_or_taxi_players(self) -> None:
        starters = tuple(
            Player(f"{position}-{index}", f"{position} {index}", position, "A", 26, 40)
            for index, position in enumerate(("QB", "QB", "RB", "WR", "TE"))
        )
        ir_player = Player("ir", "IR Stash", "RB", "A", 22, 5, "IR")
        roster = Roster("1", "Mine", "Me", starters + (ir_player,), reserve_player_ids=("ir",))
        add = Player("add", "Waiver WR", "WR", "B", 23, 30)
        league = replace(self._league((roster,)), free_agents=(add,), active_roster_capacity=5)

        ideas = generate_waiver_recommendations(league)

        self.assertTrue(all(idea.drop != ir_player for idea in ideas))

    def test_redraft_edge_excludes_trajectory(self) -> None:
        young = Player("young", "Young", "WR", "A", 21, 50)
        old = Player("old", "Old", "WR", "B", 33, 50)
        roster = Roster("1", "A", "A", (young, old))
        stats = {
            player.id: {"gp": 10, "rec": 50, "rec_yd": 700, "rec_td": 5, "tgt": 80, "off_snp": 500, "tm_off_snp": 700}
            for player in (young, old)
        }
        league = replace(self._league((roster,)), mode="redraft", player_stats=stats)
        projections = {item.player.id: item for item in compute_projections(league)}
        self.assertEqual(projections["young"].edge_score, projections["old"].edge_score)

    def test_peak_age_quarterback_is_not_labeled_as_declining(self) -> None:
        quarterback = Player("qb", "Prime QB", "QB", "A", 30, 90)
        roster = Roster("1", "A", "A", (quarterback,))
        stats = {"qb": {"gp": 7, "pass_att": 240, "pass_cmp": 160, "pass_yd": 1900, "pass_td": 15, "pass_int": 4, "off_snp": 450, "tm_off_snp": 470}}
        league = replace(self._league((roster,)), player_stats=stats, player_teams={"qb": "A"})
        projection = compute_projections(league)[0]
        self.assertEqual(projection.trajectory, "PEAK")
        self.assertNotIn(projection.recommendation, {"SELL", "STRONG SELL"})

    def test_injured_player_cannot_receive_confident_market_signal(self) -> None:
        injured = Player("injured", "Injured Star", "WR", "A", 25, 90, "IR")
        roster = Roster("1", "A", "A", (injured,))
        stats = {"injured": {"gp": 5, "rec": 30, "rec_yd": 400, "rec_td": 3, "tgt": 45, "off_snp": 250, "tm_off_snp": 350}}
        league = replace(self._league((roster,)), player_stats=stats, player_teams={"injured": "A"})
        projection = compute_projections(league)[0]
        self.assertEqual(projection.recommendation, "LOW CONFIDENCE")

    def test_recommendations_use_assets_owned_by_the_named_teams(self) -> None:
        qb = Player("qb", "QB", "QB", "A", 27, 70)
        rb1 = Player("rb1", "RB One", "RB", "A", 25, 80)
        rb2 = Player("rb2", "RB Two", "RB", "A", 25, 60)
        te = Player("te", "TE", "TE", "A", 25, 50)
        target = Player("wr", "Target WR", "WR", "B", 25, 55)
        partner_qb = Player("pqb", "Partner QB", "QB", "B", 27, 50)
        partner_rb = Player("prb", "Partner RB", "RB", "B", 27, 20)
        partner_te = Player("pte", "Partner TE", "TE", "B", 27, 20)
        mine_depth = (
            Player("qb2", "QB Two", "QB", "A", 28, 30), Player("qb3", "QB Three", "QB", "A", 29, 20), Player("rb3", "RB Three", "RB", "A", 24, 25),
            Player("rb4", "RB Four", "RB", "A", 25, 20), Player("wr2", "WR Two", "WR", "A", 24, 20), Player("te2", "TE Two", "TE", "A", 27, 18),
        )
        other_depth = (
            Player("pqb2", "Partner QB Two", "QB", "B", 29, 25), Player("prb2", "Partner RB Two", "RB", "B", 25, 18),
            Player("pwr2", "Partner WR Two", "WR", "B", 25, 25), Player("pte2", "Partner TE Two", "TE", "B", 25, 18),
        )
        mine = Roster("1", "Mine", "Me", (qb, rb1, rb2, te) + mine_depth)
        other = Roster("2", "Other", "Them", (target, partner_qb, partner_rb, partner_te) + other_depth)
        league = replace(
            self._league((mine, other)),
            weekly_points={"qb": 20, "rb1": 16, "rb2": 12, "te": 9, "wr": 18, "pqb": 17, "prb": 6, "pte": 6, "qb2": 14, "qb3": 8, "rb3": 8, "rb4": 7, "wr2": 6, "te2": 6, "pqb2": 12, "prb2": 6, "pwr2": 8, "pte2": 5},
        )
        ideas = generate_recommendations(league, include_low_confidence=True)
        self.assertTrue(ideas)
        for idea in ideas:
            self.assertTrue(all(player in mine.players for player in idea.send_players))
            self.assertTrue(all(player in idea.partner.players for player in idea.receive_players))
            self.assertGreaterEqual(idea.evaluation.acceptance_score, 38)
            self.assertLessEqual(idea.score, idea.evaluation.acceptance_score + 30)
            self.assertIn(idea.confidence, {"A", "B", "C", "D"})
            self.assertTrue(idea.confidence_reasons)
            self.assertTrue(any(label == "Market fairness" for label, _ in idea.score_breakdown))

    def test_redraft_recommendations_never_trade_future_picks(self) -> None:
        old = Player("old", "Old RB", "RB", "A", 31, 50)
        target = Player("target", "Target WR", "WR", "B", 25, 50)
        pick = DraftPick(2027, 1, "2", "2", 30)
        mine = Roster("1", "Mine", "Me", (old,))
        other = Roster("2", "Other", "Them", (target,), (pick,))
        league = replace(self._league((mine, other)), mode="redraft")
        ideas = generate_recommendations(league)
        self.assertTrue(all(not idea.send_picks and not idea.receive_picks for idea in ideas))

    def test_team_plan_is_actionable_and_protects_elite_assets(self) -> None:
        elite = Player("elite", "Elite QB", "QB", "A", 24, 90)
        aging = Player("aging", "Aging RB", "RB", "A", 29, 45)
        receiver = Player("wr", "Receiver", "WR", "A", 24, 40)
        tight_end = Player("te", "Tight End", "TE", "A", 25, 25)
        mine = Roster("1", "Mine", "Me", (elite, aging, receiver, tight_end))
        other = Roster("2", "Other", "Them", (Player("other", "Other QB", "QB", "B", 28, 60),))
        plan = build_team_plan(self._league((mine, other)))
        self.assertIn(elite, plan.protect)
        self.assertTrue(plan.priority_positions)
        self.assertGreaterEqual(len(plan.actions), 3)

    def test_first_place_record_creates_win_now_context_despite_weaker_assets(self) -> None:
        def players(prefix: str, value: int, age: int = 26) -> tuple[Player, ...]:
            return tuple(
                Player(f"{prefix}-{position}", f"{prefix} {position}", position, prefix, age, value)
                for position in ("QB", "RB", "WR", "TE")
            )

        leader = Roster("1", "Record Leader", "Me", players("A", 30), wins=8, losses=1, points_for=1200)
        asset_one = Roster("2", "Asset One", "B", players("B", 90), wins=4, losses=5, points_for=940)
        asset_two = Roster("3", "Asset Two", "C", players("C", 75), wins=5, losses=4, points_for=980)
        asset_three = Roster("4", "Asset Three", "D", players("D", 60), wins=3, losses=6, points_for=900)
        league = replace(self._league((leader, asset_one, asset_two, asset_three)), team_count=4)

        context = build_contexts(league)[leader.team_id]

        self.assertEqual(context.record_rank, 1)
        self.assertEqual(context.league_rank, 1)
        self.assertEqual(context.asset_rank, 4)
        self.assertEqual(context.window, "Win Now")
        self.assertIn("8-1 record", build_team_plan(league).headline)

    def test_playoff_model_distinguishes_proven_and_unlucky_contenders(self) -> None:
        def roster(team_id: str, wins: int, points: float, value: int) -> Roster:
            players = tuple(
                Player(f"{team_id}-{position}", f"{team_id} {position}", position, team_id, 26, value)
                for position in ("QB", "RB", "WR", "TE")
            )
            return Roster(team_id, f"Team {team_id}", team_id, players, wins=wins, losses=6 - wins, points_for=points)

        teams = (roster("1", 5, 720, 80), roster("2", 4, 610, 65), roster("3", 2, 700, 75), roster("4", 1, 500, 45))
        league = replace(
            self._league(teams),
            team_count=4,
            playoff_teams=2,
            current_week=7,
            trade_deadline_week=8,
            remaining_matchups=((7, "1", "4"), (7, "2", "3"), (8, "1", "3"), (8, "2", "4")),
        )

        contexts = build_contexts(league)

        self.assertEqual(contexts["1"].contender_confidence, "Proven contender")
        self.assertEqual(contexts["3"].contender_confidence, "Unlucky contender")
        self.assertIsNotNone(contexts["1"].playoff_probability)
        self.assertGreater(contexts["1"].playoff_probability, contexts["4"].playoff_probability)
        self.assertIsNotNone(contexts["1"].schedule_difficulty)
        self.assertEqual(contexts["1"].deadline_status, "1 week to deadline")
        self.assertGreater(contexts["1"].deadline_urgency, 50)

    def test_trade_finder_pauses_after_the_league_deadline(self) -> None:
        player_a = Player("a", "Player A", "RB", "A", 25, 50)
        player_b = Player("b", "Player B", "WR", "B", 25, 50)
        team_a = Roster("1", "A", "A", (player_a,), wins=5, losses=3)
        team_b = Roster("2", "B", "B", (player_b,), wins=3, losses=5)
        league = replace(self._league((team_a, team_b)), current_week=10, trade_deadline_week=9)

        self.assertEqual(generate_recommendations(league), [])

    def test_recommendation_position_filter_is_applied_before_limit(self) -> None:
        qb = Player("qb", "QB", "QB", "A", 27, 70)
        rb = Player("rb", "RB", "RB", "A", 25, 60)
        mine = Roster("1", "Mine", "Me", (qb, rb, Player("qb2", "QB2", "QB", "A", 28, 30), Player("qb3", "QB3", "QB", "A", 29, 20), Player("rb2", "RB2", "RB", "A", 24, 25), Player("rb3", "RB3", "RB", "A", 25, 20), Player("wr2", "WR2", "WR", "A", 25, 20)))
        target = Player("target", "Target WR", "WR", "B", 25, 55)
        other = Roster("2", "Other", "Them", (target, Player("other-wr", "Other WR", "WR", "B", 25, 25), Player("other-qb", "Other QB", "QB", "B", 28, 60), Player("other-qb2", "Other QB2", "QB", "B", 29, 25)))
        league = replace(self._league((mine, other)), weekly_points={"qb": 18, "rb": 12, "qb2": 12, "qb3": 7, "rb2": 7, "rb3": 6, "wr2": 5, "target": 14, "other-wr": 7, "other-qb": 18, "other-qb2": 11})
        ideas = generate_recommendations(league, limit=1, target_position="WR", include_low_confidence=True)
        self.assertTrue(ideas)
        self.assertTrue(all(idea.receive_players[0].position == "WR" for idea in ideas))


if __name__ == "__main__":
    unittest.main()
