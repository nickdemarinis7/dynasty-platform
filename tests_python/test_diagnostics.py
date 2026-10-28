import unittest
from datetime import datetime, timezone

from python_app.diagnostics import build_diagnostic_report
from python_app.models import League, Player, Roster, SourceHealth


class DiagnosticReportTests(unittest.TestCase):
    def _league(self, player: Player) -> League:
        roster = Roster("1", "Team", "Manager", (player,))
        return League(
            "league", "Test", "2026", "dynasty", 1, False, False, "half_ppr",
            (("WR", 1),), "1", (roster,), "live", current_week=8,
            player_stats={player.id: {"gp": 7}}, weekly_points={player.id: 10},
            source_health=(SourceHealth("Test provider", "ready", "Loaded"),),
            imported_at=datetime.now(timezone.utc).isoformat(),
            regular_season_end=14, remaining_matchups=((8, "1", "1"),),
            playoff_weekly_points={15: {player.id: 10}}, free_agents=(Player("fa", "Free Agent", "RB", "B", 23, 10),),
            manager_tendencies={"1": {"trades": 2}}, import_duration_ms=850,
        )

    def test_complete_evidence_reports_healthy(self) -> None:
        report = build_diagnostic_report(self._league(Player("p", "Player", "WR", "A", 25, 50)))
        self.assertEqual(report.level, "Healthy")
        self.assertGreaterEqual(report.score, 85)
        self.assertTrue(any(label == "Import duration" and value == "850 ms" for label, value in report.metrics))

    def test_missing_evidence_and_duplicate_ownership_are_flagged(self) -> None:
        player = Player("p", "Player", "WR", "A", 25, 0)
        first = Roster("1", "One", "A", (player,))
        second = Roster("2", "Two", "B", (player,))
        league = League(
            "league", "Test", "2026", "dynasty", 2, False, False, "half_ppr",
            (("WR", 1),), "1", (first, second), "unavailable", current_week=8,
        )
        report = build_diagnostic_report(league)
        self.assertEqual(report.level, "Needs attention")
        self.assertTrue(any("ownership conflicts" in issue for issue in report.issues))
        self.assertTrue(any("Market values" in issue for issue in report.issues))
        self.assertLess(report.score, 65)


if __name__ == "__main__":
    unittest.main()
