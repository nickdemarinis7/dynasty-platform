import unittest

from python_app.providers import _parse_weekly_projection_stats


class ProjectionProviderTests(unittest.TestCase):
    def test_current_sleeper_list_response_is_parsed(self) -> None:
        payload = [
            {"player_id": "123", "stats": {"pass_yd": 250.5, "pass_td": 2, "label": "ignored"}},
            {"player_id": "456", "stats": {"rush_yd": 70}},
        ]
        self.assertEqual(
            _parse_weekly_projection_stats(payload),
            {"123": {"pass_yd": 250.5, "pass_td": 2.0}, "456": {"rush_yd": 70.0}},
        )

    def test_legacy_sleeper_mapping_response_remains_supported(self) -> None:
        payload = {"123": {"stats": {"rec": 6, "rec_yd": 81}}}
        self.assertEqual(_parse_weekly_projection_stats(payload), {"123": {"rec": 6.0, "rec_yd": 81.0}})

    def test_invalid_projection_response_is_empty(self) -> None:
        self.assertEqual(_parse_weekly_projection_stats({"123": {"status": "active"}}), {})
        self.assertEqual(_parse_weekly_projection_stats("not-json-data"), {})


if __name__ == "__main__":
    unittest.main()
