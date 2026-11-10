import unittest

from python_app.analytics import build_contexts, evaluate_trade
from python_app.journal import MODEL_VERSION, build_calibration_report, journal_partner_tendencies, trade_snapshot, waiver_snapshot
from python_app.models import DraftPick, League, Player, Roster
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
        self.assertEqual(snapshot["payload"]["partner"]["team_id"], self.team_b.team_id)
        self.assertEqual(snapshot["payload"]["score_breakdown"][0]["contribution"], 3.5)
        self.assertEqual(snapshot["status"], "considering")

    def test_trade_snapshot_records_pick_projection_inputs(self) -> None:
        pick = DraftPick(2027, 2, "2", "1", 15)
        team_a = Roster("1", "Alpha", "Me", (self.player_a,), (pick,), wins=6, losses=2, points_for=900)
        league = League(
            "league", "Test League", "2026", "dynasty", 3, False, False, "half_ppr",
            (("WR", 1),), "1", (team_a, self.team_b, Roster("3", "Gamma", "Other", wins=1, losses=7, points_for=500)), "live",
            weekly_points={"a": 10, "b": 12},
        )
        result = evaluate_trade(team_a, self.team_b, [], [self.player_b], league, [pick], [])
        snapshot = trade_snapshot(league, team_a, self.team_b, [], [self.player_b], [pick], [], result, build_contexts(league)["1"], source="test")
        stored = snapshot["payload"]["send_picks"][0]
        self.assertIn("adjusted_value", stored)
        self.assertIn("projection", stored)
        self.assertIn("range", stored)
        self.assertIn("class_outlook", stored)
        self.assertIn("class_multiplier", stored)
        self.assertIn("top_prospects", stored)

    def test_waiver_snapshot_preserves_faab_and_drop(self) -> None:
        add = Player("add", "Add", "RB", "C", 22, 25)
        idea = WaiverRecommendation(add, self.player_a, "DYNASTY STASH", 78, 0, None, 4, 10, "Younger asset", "B", suggested_faab=9)
        snapshot = waiver_snapshot(self.league, self.team_a, idea)

        self.assertEqual(snapshot["payload"]["add"]["id"], "add")
        self.assertEqual(snapshot["payload"]["drop"]["id"], "a")
        self.assertEqual(snapshot["payload"]["suggested_faab"], 9)
        self.assertEqual(snapshot["payload"]["faab_remaining"], 75)
        self.assertEqual(snapshot["decision_type"], "waiver")

    def test_calibration_ignores_unrecorded_outcomes_instead_of_treating_them_as_zero(self) -> None:
        decisions = [
            {"status": "accepted", "feedback": "Useful", "outcome": {}, "payload": {"confidence": "A", "prediction": {"lineup_change": 4.0}}},
            {"status": "completed", "feedback": "Useful", "outcome": {"actual_lineup_change": 3.0}, "payload": {"confidence": "A", "prediction": {"lineup_change": 4.0}}},
            {"status": "rejected", "feedback": "Partner would not accept", "outcome": {}, "payload": {"confidence": "C", "prediction": {"lineup_change": 2.0}}},
        ]
        report = build_calibration_report(decisions)
        self.assertEqual(report.resolved, 3)
        self.assertEqual(report.observed, 1)
        self.assertEqual(report.mean_absolute_error, 1.0)
        self.assertEqual(report.positive_rate, 2 / 3)
        self.assertEqual(report.directional_accuracy, 1.0)

    def test_calibration_splits_outcomes_by_confidence(self) -> None:
        decisions = [
            {"status": "completed", "outcome": {"actual_lineup_change": 2.0}, "payload": {"confidence": "A", "prediction": {"lineup_change": 3.0}}},
            {"status": "rejected", "outcome": {}, "payload": {"confidence": "C", "prediction": {"lineup_change": 1.0}}},
        ]
        report = build_calibration_report(decisions)
        slices = {item.label: item for item in report.by_confidence}
        self.assertEqual(slices["A"].positive_rate, 1.0)
        self.assertEqual(slices["C"].positive_rate, 0.0)

    def test_calibration_scores_partner_fit_predictions(self) -> None:
        decisions = [
            {"decision_type": "trade", "status": "accepted", "payload": {"prediction": {"partner_fit": 80}}},
            {"decision_type": "trade", "status": "rejected", "payload": {"prediction": {"partner_fit": 60}}},
            {"decision_type": "waiver", "status": "completed", "payload": {"prediction": {"partner_fit": 99}}},
        ]
        report = build_calibration_report(decisions)
        self.assertEqual(report.partner_observed, 2)
        self.assertAlmostEqual(report.partner_brier_score, 0.20)
        self.assertAlmostEqual(report.partner_fit_bias, 20.0)

    def test_partner_tendencies_group_outcomes_and_rejection_feedback(self) -> None:
        decisions = [
            {"decision_type": "trade", "status": "accepted", "feedback": None, "payload": {"partner": {"team_id": "2"}}},
            {"decision_type": "trade", "status": "rejected", "feedback": "Partner would not accept", "payload": {"partner": {"team_id": "2"}}},
            {"decision_type": "trade", "status": "considering", "feedback": "Partner would not accept", "payload": {"partner": {"team_id": "3"}}},
        ]
        learned = journal_partner_tendencies(decisions)
        self.assertEqual(learned["2"]["journal_resolved"], 2)
        self.assertEqual(learned["2"]["journal_accepted"], 1)
        self.assertEqual(learned["2"]["journal_partner_reject_feedback"], 1)
        self.assertEqual(learned["3"]["journal_resolved"], 0)
        self.assertEqual(learned["3"]["journal_partner_reject_feedback"], 1)


if __name__ == "__main__":
    unittest.main()
