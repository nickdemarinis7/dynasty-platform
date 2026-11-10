import unittest

from python_app.providers import _league_mode, _parse_devy_prospects, _parse_secondary_market_values, _parse_trending_players, _parse_weekly_projection_stats


class ProjectionProviderTests(unittest.TestCase):
    def test_league_mode_accepts_numeric_strings_and_root_fallback(self) -> None:
        self.assertEqual(_league_mode({"settings": {"type": "2"}}), "dynasty")
        self.assertEqual(_league_mode({"type": 1}), "keeper")
        self.assertEqual(_league_mode({"settings": {"type": 0}}), "redraft")

    def test_devy_response_is_normalized_and_invalid_rows_are_ignored(self) -> None:
        payload = {"data": [
            {"rank": 1, "playerName": "Jeremiah Smith", "playerID": 16015, "position": "WR", "school": "OSU", "eligibleYear": 2027, "ktcValue": 9960},
            {"rank": 2, "playerName": "Missing Value", "position": "QB", "eligibleYear": 2028},
        ]}
        prospects = _parse_devy_prospects(payload)
        self.assertEqual(len(prospects), 1)
        self.assertEqual(prospects[0].name, "Jeremiah Smith")
        self.assertEqual(prospects[0].eligible_year, 2027)
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

    def test_secondary_market_values_use_requested_format_and_scale(self) -> None:
        payload = {"players": [
            {"id": "123", "value": {"sf_dynasty": 8200, "non_sf_dynasty": 6100}},
            {"id": "missing", "value": {"non_sf_dynasty": 5000}},
        ]}
        self.assertEqual(_parse_secondary_market_values(payload, "sf_dynasty"), {"123": 82.0})

    def test_trending_players_are_normalized_and_invalid_rows_ignored(self) -> None:
        payload = [
            {"player_id": "123", "count": 1450},
            {"player_id": "456", "count": "82"},
            {"player_id": None, "count": 99},
            {"player_id": "bad", "count": "unknown"},
        ]
        self.assertEqual(_parse_trending_players(payload), {"123": 1450, "456": 82})
        self.assertEqual(_parse_trending_players({"not": "a list"}), {})


if __name__ == "__main__":
    unittest.main()
