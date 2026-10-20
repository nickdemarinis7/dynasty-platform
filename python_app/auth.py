from __future__ import annotations

import streamlit as st


def authentication_configured() -> bool:
    try:
        return "auth" in st.secrets
    except (FileNotFoundError, KeyError):
        return False


def require_login() -> None:
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
        return str(claims.get("sub") or claims.get("email") or "authenticated-user")
    username = st.session_state.get("username")
    return f"local:{username or 'anonymous'}"
