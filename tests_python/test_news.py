from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

import requests

from python_app.news import get_player_news


class PlayerNewsTests(unittest.TestCase):
    @patch("python_app.news.requests.get")
    def test_google_feed_is_parsed_with_attribution(self, get: Mock) -> None:
        response = Mock()
        response.content = b"""<?xml version="1.0"?><rss><channel><item>
            <title>Player earns larger role</title>
            <link>https://news.google.com/articles/example</link>
            <pubDate>Tue, 17 Nov 2026 15:30:00 GMT</pubDate>
            <source>Example Sports</source>
        </item></channel></rss>"""
        response.raise_for_status.return_value = None
        get.return_value = response

        items = get_player_news("Example Player", "NYJ")

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].title, "Player earns larger role")
        self.assertEqual(items[0].source, "Example Sports")
        self.assertEqual(items[0].url, "https://news.google.com/articles/example")

    @patch("python_app.news.requests.get", side_effect=requests.Timeout("offline"))
    def test_provider_outage_returns_empty_results(self, _get: Mock) -> None:
        # External news is optional and must never make player profiles fail.
        self.assertEqual(get_player_news("Example Player", "NYJ"), ())


if __name__ == "__main__":
    unittest.main()
