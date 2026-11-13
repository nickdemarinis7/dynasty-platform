from types import SimpleNamespace
import unittest
from unittest.mock import patch

from python_app import storage


class StoragePrivacyTests(unittest.TestCase):
    def test_delete_all_user_data_clears_local_records(self) -> None:
        session = {
            "saved_trades": [{"id": "trade"}],
            "decision_journal": [{"id": "decision"}],
            "league": object(),
        }
        fake_st = SimpleNamespace(secrets={}, session_state=session)
        with (
            patch.object(storage, "st", fake_st),
            patch.object(storage, "durable_storage_credentials_configured", return_value=False),
        ):
            storage.delete_all_user_data("local:test")
        self.assertNotIn("saved_trades", session)
        self.assertNotIn("decision_journal", session)
        self.assertIn("league", session)

    def test_delete_all_user_data_scopes_both_remote_deletes(self) -> None:
        calls: list[tuple[str, str, dict[str, str]]] = []

        def request(method: str, path: str, *, params=None, json=None):
            calls.append((method, path, params))

        with (
            patch.object(storage, "durable_storage_credentials_configured", return_value=True),
            patch.object(storage, "durable_storage_configured", return_value=True),
            patch.object(storage, "_request", side_effect=request),
        ):
            storage.delete_all_user_data("oidc-subject")
        self.assertEqual(calls, [
            ("DELETE", "saved_trades", {"user_id": "eq.oidc-subject"}),
            ("DELETE", "decision_journal", {"user_id": "eq.oidc-subject"}),
        ])


if __name__ == "__main__":
    unittest.main()
