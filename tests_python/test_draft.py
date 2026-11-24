import unittest

from python_app.draft import build_pick_order, select_relevant_draft, uses_rookie_only_pool
from python_app.models import League, Player, Roster
from python_app.providers import ProviderError


class DraftTests(unittest.TestCase):
    def test_redraft_uses_full_player_pool(self) -> None:
        roster = Roster("1", "A", "A", (Player("v", "Veteran", "WR", "A", 27, 40),))
        league = League("l", "L", "2026", "redraft", 1, False, False, "half_ppr", (("WR", 1),), "1", (roster,), "live")
        self.assertFalse(uses_rookie_only_pool(league))

    def test_established_dynasty_uses_rookie_pool(self) -> None:
        players = tuple(Player(str(index), f"P{index}", "WR", "A", 25, 10) for index in range(6))
        roster = Roster("1", "A", "A", players)
        league = League("l", "L", "2026", "dynasty", 1, False, False, "half_ppr", (("WR", 1),), "1", (roster,), "live")
        self.assertTrue(uses_rookie_only_pool(league))

    def test_dynasty_startup_uses_full_player_pool(self) -> None:
        roster = Roster("1", "A", "A")
        league = League("l", "L", "2026", "dynasty", 1, False, False, "half_ppr", (("WR", 1),), "1", (roster,), "live")
        self.assertFalse(uses_rookie_only_pool(league))
    def test_snake_order_reverses_even_rounds(self) -> None:
        draft = {
            "type": "snake",
            "settings": {"teams": 3, "rounds": 2},
            "slot_to_roster_id": {"1": 10, "2": 20, "3": 30},
        }
        self.assertEqual(build_pick_order(draft), [10, 20, 30, 30, 20, 10])

    def test_linear_order_does_not_reverse(self) -> None:
        draft = {
            "type": "linear",
            "settings": {"teams": 2, "rounds": 2},
            "slot_to_roster_id": {"1": 1, "2": 2},
        }
        self.assertEqual(build_pick_order(draft), [1, 2, 1, 2])

    def test_incomplete_slot_mapping_is_rejected(self) -> None:
        draft = {"type": "snake", "settings": {"teams": 2, "rounds": 1}, "slot_to_roster_id": {"1": 1}}
        with self.assertRaises(ProviderError):
            build_pick_order(draft)

    def test_current_season_actionable_draft_is_selected(self) -> None:
        drafts = [
            {"draft_id": "old", "season": "2025", "status": "drafting", "start_time": 5},
            {"draft_id": "done", "season": "2026", "status": "complete", "start_time": 10},
            {"draft_id": "live", "season": "2026", "status": "drafting", "start_time": 1},
        ]
        self.assertEqual(select_relevant_draft(drafts, "2026")["draft_id"], "live")


if __name__ == "__main__":
    unittest.main()
