from __future__ import annotations

import streamlit as st

from python_app.providers import ProviderError, get_leagues, get_nfl_state, get_user, import_league
from python_app.views import draft, history, home, projections, rankings, recommendations, rosters, trade, values
from python_app.auth import authentication_configured, require_login

st.set_page_config(page_title="Fantasy GM", page_icon="🏈", layout="centered", initial_sidebar_state="collapsed")

st.markdown("""
<style>
  .block-container {max-width: 760px; padding: 1rem 1rem 6rem;}
  [data-testid="stHeader"] {background: rgba(17,19,24,.88);}
  [data-testid="stMetric"] {background: #1b1e25; border: 1px solid #2b2f39; border-radius: 12px; padding: .65rem;}
  div[data-testid="stVerticalBlockBorderWrapper"] {border-color: #2b2f39; border-radius: 14px;}
  button, input, [role="button"] {min-height: 44px;}
  h1 {font-size: clamp(1.75rem, 8vw, 2.5rem) !important;}
  @media (max-width: 640px) {
    .block-container {padding-top: max(.75rem, env(safe-area-inset-top)); padding-bottom: calc(5rem + env(safe-area-inset-bottom));}
    [data-testid="stMetricValue"] {font-size: 1.15rem;}
    [data-testid="column"] {min-width: 0 !important;}
  }
</style>
""", unsafe_allow_html=True)

require_login()


def connect() -> None:
    st.title("Fantasy GM")
    st.caption("Dynasty and redraft decision support for Sleeper leagues")
    username = st.text_input("Sleeper username", placeholder="Enter your username")
    if not username:
        st.info("Connect a Sleeper account to begin.")
        return
    try:
        with st.spinner("Finding leagues…"):
            user = get_user(username)
            state = get_nfl_state()
            available = get_leagues(str(user["user_id"]), str(state["season"]))
        if not available:
            st.warning(f"No NFL leagues were found for {state['season']}.")
            return
        labels = {f"{league.get('name', 'League')} · {league.get('season', state['season'])}": str(league["league_id"]) for league in available}
        selected = st.selectbox("League", labels)
        if st.button("Import league", type="primary", use_container_width=True):
            with st.spinner("Importing rosters and market values…"):
                st.session_state.league = import_league(username, labels[selected])
                st.session_state.username = username
            st.rerun()
    except ProviderError as exc:
        st.error(str(exc))


league = st.session_state.get("league")
if league is None:
    connect()
else:
    top, action = st.columns([4, 1])
    top.caption(f"{league.name} · {league.mode.title()}")
    if action.button("Reset"):
        st.session_state.clear()
        st.rerun()
    if authentication_configured():
        account, logout = st.columns([4, 1])
        account.caption(f"Signed in as {st.user.get('email', st.user.get('name', 'user'))}")
        logout.button("Log out", on_click=st.logout)
    page = st.selectbox("Go to", ["Home", "Rosters", "Trade", "Trade Finder", "Saved Trades", "Live Draft", "Rankings", "Values", "Edge Intelligence"], label_visibility="collapsed", key="page")
    {"Home": home, "Rosters": rosters, "Trade": trade, "Trade Finder": recommendations, "Saved Trades": history, "Live Draft": draft, "Rankings": rankings, "Values": values, "Edge Intelligence": projections}[page](league)
