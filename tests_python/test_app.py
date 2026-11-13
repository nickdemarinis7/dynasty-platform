import unittest
from pathlib import Path

from streamlit.testing.v1 import AppTest

from python_app.models import League, Player, Roster


def _connected_league() -> League:
    mine = Roster(
        "1", "My Team", "me",
        (
            Player("qb1", "Quarterback One", "QB", "AAA", 26, 50),
            Player("rb1", "Running Back One", "RB", "AAA", 24, 45),
            Player("wr1", "Receiver One", "WR", "AAA", 25, 44),
            Player("te1", "Tight End One", "TE", "AAA", 26, 32),
        ),
        wins=5, losses=3, points_for=900,
    )
    other = Roster(
        "2", "Other Team", "other",
        (
            Player("qb2", "Quarterback Two", "QB", "BBB", 27, 48),
            Player("rb2", "Running Back Two", "RB", "BBB", 25, 42),
            Player("wr2", "Receiver Two", "WR", "BBB", 24, 46),
            Player("te2", "Tight End Two", "TE", "BBB", 27, 30),
        ),
        wins=4, losses=4, points_for=850,
    )
    weekly = {player.id: 10.0 for roster in (mine, other) for player in roster.players}
    return League(
        "qa", "QA League", "2026", "redraft", 2, False, False, "half_ppr",
        (("QB", 1), ("RB", 1), ("WR", 1), ("TE", 1), ("BN", 4)),
        "1", (mine, other), "live", weekly_points=weekly,
    )


class StreamlitSmokeTests(unittest.TestCase):
    def test_disconnected_app_renders_without_exceptions(self) -> None:
        app = AppTest.from_file(str(Path(__file__).resolve().parents[1] / "streamlit_app.py"))
        app.run(timeout=10)
        self.assertFalse(app.exception)
        self.assertEqual(app.title[0].value, "Fantasy GM")
        self.assertTrue(any(item.label == "Sleeper username" for item in app.text_input))

    def test_connected_home_renders_and_theme_toggle_is_deterministic(self) -> None:
        app = AppTest.from_file(str(Path(__file__).resolve().parents[1] / "streamlit_app.py"))
        app.session_state["_app_state_schema_version"] = 16
        app.session_state["league"] = _connected_league()
        app.session_state["username"] = "me"
        app.session_state["color_mode"] = "Dark"
        app.run(timeout=15)
        self.assertFalse(app.exception)
        self.assertEqual(app.session_state["color_mode"], "Dark")
        theme_button = next(button for button in app.button if button.label == "☾")
        theme_button.click().run(timeout=15)
        self.assertEqual(app.session_state["color_mode"], "Light")

    def test_switch_league_preserves_explicit_theme(self) -> None:
        app = AppTest.from_file(str(Path(__file__).resolve().parents[1] / "streamlit_app.py"))
        app.session_state["_app_state_schema_version"] = 16
        app.session_state["league"] = _connected_league()
        app.session_state["username"] = "me"
        app.session_state["color_mode"] = "Dark"
        app.run(timeout=15)
        next(button for button in app.button if button.label == "Switch").click().run(timeout=15)
        self.assertEqual(app.session_state["color_mode"], "Dark")
        self.assertNotIn("league", app.session_state)
        self.assertTrue(any(item.label == "Sleeper username" for item in app.text_input))

    def test_connected_primary_routes_render_without_exceptions(self) -> None:
        routes = (
            ("Plan", "Roster"), ("Plan", "League"),
            ("Moves", "Target"), ("Moves", "Waivers"), ("Moves", "Evaluate"), ("Moves", "Journal"),
            ("Market", "Values"), ("Market", "Signals"), ("Market", "Data"),
            ("Draft", "Draft room"),
        )
        app_path = str(Path(__file__).resolve().parents[1] / "streamlit_app.py")
        for area, view in routes:
            with self.subTest(area=area, view=view):
                app = AppTest.from_file(app_path)
                app.session_state["_app_state_schema_version"] = 16
                app.session_state["league"] = _connected_league()
                app.session_state["username"] = "me"
                app.session_state["color_mode"] = "Dark"
                app.session_state["area"] = area
                app.session_state["view"] = view
                app.run(timeout=15)
                self.assertFalse(app.exception)


if __name__ == "__main__":
    unittest.main()
