from types import SimpleNamespace
import unittest
from unittest.mock import patch

from python_app import auth


class StopExecution(RuntimeError):
    pass


def fake_streamlit(*, secrets: dict, logged_in: bool = False, claims: dict | None = None):
    return SimpleNamespace(
        secrets=secrets,
        user=SimpleNamespace(is_logged_in=logged_in, to_dict=lambda: claims or {}),
        session_state={},
        title=lambda *_args, **_kwargs: None,
        error=lambda *_args, **_kwargs: None,
        caption=lambda *_args, **_kwargs: None,
        button=lambda *_args, **_kwargs: None,
        login=lambda: None,
        stop=lambda: (_ for _ in ()).throw(StopExecution()),
    )


class AuthenticationBoundaryTests(unittest.TestCase):
    def test_local_session_can_run_without_auth_or_storage(self) -> None:
        with patch.object(auth, "st", fake_streamlit(secrets={})):
            auth.require_login()
            self.assertEqual(auth.current_user_id(), "local:anonymous")

    def test_storage_credentials_without_auth_fail_closed(self) -> None:
        st = fake_streamlit(secrets={"supabase": {"url": "https://example.test", "service_role_key": "secret"}})
        with patch.object(auth, "st", st):
            with self.assertRaises(StopExecution):
                auth.require_login()
            with self.assertRaisesRegex(RuntimeError, "requires an authenticated user"):
                auth.current_user_id()

    def test_authenticated_identity_uses_stable_subject(self) -> None:
        st = fake_streamlit(
            secrets={"auth": {"client_id": "client"}},
            logged_in=True,
            claims={"sub": "oidc-subject", "email": "person@example.test"},
        )
        with patch.object(auth, "st", st):
            self.assertEqual(auth.current_user_id(), "oidc-subject")

    def test_authenticated_identity_requires_subject_claim(self) -> None:
        st = fake_streamlit(
            secrets={"auth": {"client_id": "client"}},
            logged_in=True,
            claims={"email": "person@example.test"},
        )
        with patch.object(auth, "st", st):
            with self.assertRaisesRegex(RuntimeError, "stable subject"):
                auth.current_user_id()


if __name__ == "__main__":
    unittest.main()
