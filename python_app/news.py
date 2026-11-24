from __future__ import annotations

from dataclasses import dataclass
from email.utils import parsedate_to_datetime
import os
from urllib.parse import quote_plus
import xml.etree.ElementTree as ET

import requests


@dataclass(frozen=True)
class PlayerNewsItem:
    title: str
    source: str
    published_at: str
    url: str


def _clean_date(value: str) -> str:
    try:
        return parsedate_to_datetime(value).strftime("%b %-d, %Y · %-I:%M %p")
    except (TypeError, ValueError, OverflowError):
        return value


def _google_news(player_name: str, team: str, limit: int) -> tuple[PlayerNewsItem, ...]:
    query = quote_plus(f'"{player_name}" NFL {team} when:30d')
    url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
    response = requests.get(url, timeout=4, headers={"User-Agent": "FantasyGM/1.0"})
    response.raise_for_status()
    root = ET.fromstring(response.content)
    output: list[PlayerNewsItem] = []
    for item in root.findall("./channel/item")[:limit]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        source_node = item.find("source")
        source = (source_node.text if source_node is not None else "Google News") or "Google News"
        published = _clean_date((item.findtext("pubDate") or "").strip())
        if title and link:
            output.append(PlayerNewsItem(title, source.strip(), published, link))
    return tuple(output)


def _fantasypros_news(player_name: str, limit: int, api_key: str) -> tuple[PlayerNewsItem, ...]:
    response = requests.get(
        "https://api.fantasypros.com/v2/json/nfl/news",
        params={"limit": 100},
        headers={"x-api-key": api_key, "User-Agent": "FantasyGM/1.0"},
        timeout=4,
    )
    response.raise_for_status()
    needle = player_name.lower()
    output: list[PlayerNewsItem] = []
    for item in response.json().get("items", []):
        searchable = f'{item.get("title", "")} {item.get("desc", "")}'.lower()
        if needle not in searchable:
            continue
        title = str(item.get("title") or "").strip()
        link = str(item.get("link") or "").strip()
        if title and link:
            output.append(PlayerNewsItem(
                title,
                "FantasyPros",
                str(item.get("created_formated") or item.get("created") or "").strip(),
                link,
            ))
        if len(output) >= limit:
            break
    return tuple(output)


def get_player_news(player_name: str, team: str, limit: int = 5) -> tuple[PlayerNewsItem, ...]:
    """Load attributed player headlines without making news a hard app dependency."""
    api_key = os.getenv("FANTASYPROS_API_KEY", "").strip()
    if api_key:
        try:
            items = _fantasypros_news(player_name, limit, api_key)
            if items:
                return items
        except (requests.RequestException, ValueError, TypeError):
            pass
    try:
        return _google_news(player_name, team, limit)
    except (requests.RequestException, ET.ParseError, TypeError, ValueError):
        return ()
