import unittest
from dataclasses import replace

from python_app.analytics import build_contexts, calc_fppg, compute_projections, evaluate_trade, optimize_lineup, projected_points
from python_app.models import DraftPick, League, Player, Roster
from python_app.recommendations import generate_recommendations


class RosterModelTests(unittest.TestCase):
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
        league = self._league((team_a, team_b))
        result = evaluate_trade(team_a, team_b, [weak], [strong], league)
        self.assertGreater(result.lineup_a.points_gained, 0)
        self.assertTrue(result.lineup_a.received_player_starts)

    def test_draft_pick_changes_market_fairness_without_lineup_points(self) -> None:
        player_a = Player("a", "Player A", "RB", "A", 25, 50)
        player_b = Player("b", "Player B", "RB", "B", 25, 50)
        pick = DraftPick(2027, 1, "2", "2", 30)
        team_a = Roster("1", "A", "A", (player_a,))
        team_b = Roster("2", "B", "B", (player_b,), (pick,))
        league = self._league((team_a, team_b))
        result = evaluate_trade(team_a, team_b, [player_a], [player_b], league, [], [pick])
        self.assertGreater(result.difference_for_a, 0)
        self.assertEqual(result.lineup_a.points_gained, 0)

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

    def test_recommendations_use_assets_owned_by_the_named_teams(self) -> None:
        qb = Player("qb", "QB", "QB", "A", 27, 70)
        rb1 = Player("rb1", "RB One", "RB", "A", 25, 80)
        rb2 = Player("rb2", "RB Two", "RB", "A", 25, 60)
        te = Player("te", "TE", "TE", "A", 25, 50)
        target = Player("wr", "Target WR", "WR", "B", 25, 55)
        partner_qb = Player("pqb", "Partner QB", "QB", "B", 27, 50)
        partner_rb = Player("prb", "Partner RB", "RB", "B", 27, 20)
        partner_te = Player("pte", "Partner TE", "TE", "B", 27, 20)
        mine = Roster("1", "Mine", "Me", (qb, rb1, rb2, te))
        other = Roster("2", "Other", "Them", (target, partner_qb, partner_rb, partner_te))
        league = self._league((mine, other))
        ideas = generate_recommendations(league)
        self.assertTrue(ideas)
        for idea in ideas:
            self.assertTrue(all(player in mine.players for player in idea.send_players))
            self.assertTrue(all(player in idea.partner.players for player in idea.receive_players))

    def test_redraft_recommendations_never_trade_future_picks(self) -> None:
        old = Player("old", "Old RB", "RB", "A", 31, 50)
        target = Player("target", "Target WR", "WR", "B", 25, 50)
        pick = DraftPick(2027, 1, "2", "2", 30)
        mine = Roster("1", "Mine", "Me", (old,))
        other = Roster("2", "Other", "Them", (target,), (pick,))
        league = replace(self._league((mine, other)), mode="redraft")
        ideas = generate_recommendations(league)
        self.assertTrue(all(not idea.send_picks and not idea.receive_picks for idea in ideas))


if __name__ == "__main__":
    unittest.main()
