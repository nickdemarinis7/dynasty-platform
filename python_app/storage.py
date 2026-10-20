from __future__ import annotations

from typing import Any
import requests
import streamlit as st


class StorageError(RuntimeError):
    """Persistent storage could not complete an operation."""


def _config() -> tuple[str, str] | None:
    try:
        section = st.secrets.get("supabase")
        if section and section.get("url") and section.get("service_role_key"):
            return str(section["url"]).rstrip("/"), str(section["service_role_key"])
    except (FileNotFoundError, KeyError):
        pass
    return None


def durable_storage_configured() -> bool:
    return _config() is not None


def _request(method: str, path: str, *, params: dict[str, str] | None = None, json: Any = None) -> Any:
    config = _config()
    if not config:
        raise StorageError("Durable storage is not configured")
    url, key = config
    try:
        response = requests.request(
            method, f"{url}/rest/v1/{path}", params=params, json=json, timeout=15,
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "return=representation"},
        )
        response.raise_for_status()
        return response.json() if response.content else None
    except (requests.RequestException, ValueError) as exc:
        raise StorageError("Saved-trade storage is temporarily unavailable") from exc


def load_trades(user_id: str) -> list[dict[str, Any]]:
    if not durable_storage_configured():
        return list(st.session_state.get("saved_trades", []))
    rows = _request("GET", "saved_trades", params={"user_id": f"eq.{user_id}", "select": "*", "order": "saved_at.desc"})
    return rows if isinstance(rows, list) else []


def save_trade(user_id: str, trade: dict[str, Any]) -> None:
    if not durable_storage_configured():
        st.session_state.setdefault("saved_trades", []).insert(0, trade)
        return
    _request("POST", "saved_trades", json={**trade, "user_id": user_id})


def delete_trade(user_id: str, trade_id: str) -> None:
    if not durable_storage_configured():
        saved = st.session_state.get("saved_trades", [])
        st.session_state.saved_trades = [trade for trade in saved if trade.get("id") != trade_id]
        return
    _request("DELETE", "saved_trades", params={"id": f"eq.{trade_id}", "user_id": f"eq.{user_id}"})
