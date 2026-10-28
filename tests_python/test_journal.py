import unittest

from python_app.analytics import build_contexts, evaluate_trade
from python_app.journal import MODEL_VERSION, trade_snapshot, waiver_snapshot
from python_app.models import League, Player, Roster
from python_app.waivers import WaiverRecommendation


class JournalSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.player_a = Player("a", "Player A", "WR", "A", 25, 50)
        self.player_b = Player("b", "Player B", "WR", "B", 24, 55)
        self.team_a = Roster("1", "Alpha", "Me", (self.player_a,), wins=6, losses=2, points_for=900, waiver_budget_remaining=75)
        self.team_b = Roster("2", "Beta", "Them", (self.player_b,), wins=4, losses=4, points_for=800)
        self.league = League(
            "league", "Test League", "2026", "dynasty", 2, False, False, "half_ppr",
            (("WR", 1), ("BN", 2)), "1", (self.team_a, self.team_b), "live",
            current_week=9, weekly_points={"a": 10, "b": 12}, imported_at="2026-10-27T12:00:00Z",
        )

    def test_trade_snapshot_preserves_model_inputs_and_prediction(self) -> None:
        result = evaluate_trade(self.team_a, self.team_b, [self.player_a], [self.player_b], self.league)
        context = build_contexts(self.league)["1"]
        snapshot = trade_snapshot(
            self.league, self.team_a, self.team_b, [self.player_a], [self.player_b], [], [],
            result, context, source="test", confidence="B", score=72,
            score_breakdown=(("Market fairness", 3.5),),
        )

        self.assertEqual(snapshot["payload"]["model_version"], MODEL_VERSION)
        self.assertEqual(snapshot["payload"]["send_players"][0]["value"], 50)
        self.assertEqual(snapshot["payload"]["receive_players"][0]["value"], 55)
        self.assertEqual(snapshot["payload"]["prediction"]["lineup_change"], result.lineup_a.points_gained)
        self.assertEqual(snapshot["payload"]["score_breakdown"][0]["contribution"], 3.5)
        self.assertEqual(snapshot["status"], "considering")

    def test_waiver_snapshot_preserves_faab_and_drop(self) -> None:
        add = Player("add", "Add", "RB", "C", 22, 25)
        idea = WaiverRecommendation(add, self.player_a, "DYNASTY STASH", 78, 0, None, 4, 10, "Younger asset", "B", suggested_faab=9)
        snapshot = waiver_snapshot(self.league, self.team_a, idea)

        self.assertEqual(snapshot["payload"]["add"]["id"], "add")
        self.assertEqual(snapshot["payload"]["drop"]["id"], "a")
        self.assertEqual(snapshot["payload"]["suggested_faab"], 9)
        self.assertEqual(snapshot["payload"]["faab_remaining"], 75)
        self.assertEqual(snapshot["decision_type"], "waiver")


if __name__ == "__main__":
    unittest.main()
