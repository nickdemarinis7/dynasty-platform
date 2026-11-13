from __future__ import annotations

import streamlit as st


def durable_storage_credentials_configured() -> bool:
    """Return whether server-side durable-storage credentials are present."""
    try:
        section = st.secrets.get("supabase")
        return bool(section and section.get("url") and section.get("service_role_key"))
    except (FileNotFoundError, KeyError):
        return False


def authentication_configured() -> bool:
    try:
        return "auth" in st.secrets
    except (FileNotFoundError, KeyError):
        return False


def require_login() -> None:
    if durable_storage_credentials_configured() and not authentication_configured():
        st.title("Fantasy GM")
        st.error(
            "Durable storage is configured without authentication. "
            "Add the OIDC auth settings or remove the Supabase credentials before running the app."
        )
        st.stop()
    if not authentication_configured():
        return
    if not st.user.is_logged_in:
        st.title("Fantasy GM")
        st.caption("Sign in to access your leagues and saved trades.")
        st.button("Sign in", type="primary", use_container_width=True, on_click=st.login)
        st.stop()


def current_user_id() -> str:
    if authentication_configured() and st.user.is_logged_in:
        claims = st.user.to_dict()
        subject = claims.get("sub")
        if not subject:
            raise RuntimeError("The authenticated identity does not include a stable subject identifier")
        return str(subject)
    if durable_storage_credentials_configured():
        raise RuntimeError("Durable storage requires an authenticated user")
    username = st.session_state.get("username")
    return f"local:{username or 'anonymous'}"
