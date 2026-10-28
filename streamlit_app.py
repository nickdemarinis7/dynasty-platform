from __future__ import annotations

import streamlit as st

from python_app.providers import ProviderError, get_leagues, get_nfl_state, get_user, import_league
from python_app.views import diagnostics, draft, history, home, projections, rankings, recommendations, rosters, trade, values, waivers
from python_app.auth import authentication_configured, require_login

st.set_page_config(page_title="Fantasy GM", page_icon="🏈", layout="centered", initial_sidebar_state="collapsed")

APP_STATE_SCHEMA_VERSION = 13
if st.session_state.get("_app_state_schema_version") != APP_STATE_SCHEMA_VERSION:
    st.session_state.clear()
    st.session_state._app_state_schema_version = APP_STATE_SCHEMA_VERSION

st.markdown("""
<style>
  :root {color-scheme:light;--ink:#151713;--muted:#6d7169;--line:#d7d9d1;--panel:#e9ebe4;--accent:#b6f23f;}
  html,body,[class*="css"] {font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
  .stApp {background:#f4f5f0;color:var(--ink);}
  .block-container {max-width:680px;padding:2.8rem 1.1rem 5rem;}
  [data-testid="stHeader"] {height:2.5rem;background:rgba(244,245,240,.92);backdrop-filter:blur(14px);border-bottom:1px solid rgba(21,23,19,.06);}
  [data-testid="stMetric"] {background:transparent;border:0;border-radius:0;padding:.65rem;}
  [data-testid="stMetricLabel"] {font-size: .7rem; text-transform: uppercase; letter-spacing: .06em;}
  div[data-testid="stVerticalBlockBorderWrapper"] {background:#fff;border-color:var(--line);border-radius:4px;box-shadow:none;}
  div[data-testid="stVerticalBlockBorderWrapper"] > div {padding:.65rem .75rem;}
  [data-testid="stSegmentedControl"] {width: 100%;}
  [data-testid="stSegmentedControl"] > div {width: 100%;}
  [data-testid="stSegmentedControl"] > div {background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:0;gap:0;}
  [data-testid="stSegmentedControl"] label {flex:1;justify-content:center;min-height:38px;border:0;border-radius:0;color:#656960;font-weight:650;}
  [data-testid="stSegmentedControl"] label:has(input:checked) {color:var(--ink);box-shadow:inset 0 -3px 0 var(--ink);}
  [data-testid="stPills"] button {border-radius:2px!important;font-size:.72rem!important;min-height:32px!important;padding:.25rem .65rem!important;}
  [data-testid="stExpander"] {border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;}
  [data-baseweb="select"] > div {background:#fff;border-color:#cfd2c9;border-radius:4px;min-height:46px;box-shadow:none;}
  [data-testid="stTextInput"] input {background:#fff;border-color:#cfd2c9;border-radius:4px;min-height:46px;box-shadow:none;}
  [data-testid="stMultiSelect"] [data-baseweb="select"] > div {min-height:52px;}
  .stButton > button,.stDownloadButton > button {border-radius:3px;font-weight:750;box-shadow:none;border-color:#bfc2ba;background:transparent;color:var(--ink);}
  .stButton > button:hover,.stDownloadButton > button:hover {border-color:var(--ink);color:var(--ink);}
  .stButton > button[kind="primary"] {background:var(--ink);color:#fff;border:1px solid var(--ink);box-shadow:4px 4px 0 var(--accent);}
  button, input, textarea, [role="button"] {min-height: 44px;}
  h1 {font-size:clamp(1.7rem,7vw,2.2rem)!important;letter-spacing:-.045em!important;margin-bottom:.15rem!important;font-weight:850!important;}
  h2, h3 {letter-spacing: -.02em !important;}
  .app-kicker {color:#4d5149;font-size:.64rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-bottom:.28rem;}
  .app-brand {font-size:1.03rem;font-weight:900;letter-spacing:-.035em;}
  .app-brand:before {content:"";display:inline-block;width:.55rem;height:.55rem;background:var(--accent);border:2px solid var(--ink);margin-right:.45rem;transform:rotate(45deg);}
  .app-context {color:#73776e;font-size:.7rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .page-intro {padding:1.25rem 0 .75rem;}
  .page-intro h1 {margin:.05rem 0 .2rem;font-size:clamp(1.65rem,6vw,2rem);line-height:1.08;}
  .page-intro p {color:var(--muted);font-size:.86rem;line-height:1.4;margin:0;max-width:36rem;}
  .section-title {margin:1.15rem 0 .42rem;color:#555950;font-size:.62rem;font-weight:850;letter-spacing:.14em;text-transform:uppercase;}
  .stat-grid {display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:.3rem 0 .75rem;border-block:1px solid var(--line);}
  .stat {background:transparent;border:0;border-right:1px solid var(--line);border-radius:0;padding:.65rem .8rem;min-width:0;}
  .stat:last-child {border-right:0;}
  .stat-value {color:var(--ink);font-size:1.2rem;font-weight:850;line-height:1.1;overflow:hidden;text-overflow:ellipsis;}
  .stat-label {color:#777b72;font-size:.57rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin-top:.28rem;}
  .asset-card {padding:.05rem 0;}
  .asset-title {font-size:.95rem;font-weight:800;color:var(--ink);line-height:1.25;}
  .asset-meta {color:var(--muted);font-size:.75rem;margin-top:.2rem;}
  .signal {display:inline-block;border:1px solid var(--ink);background:var(--accent);color:var(--ink);border-radius:2px;padding:.2rem .42rem;font-size:.6rem;font-weight:850;letter-spacing:.06em;}
  .field-help {color:var(--muted);font-size:.76rem;margin:-.2rem 0 .45rem;}
  .insight {border-left:4px solid var(--accent);background:#fff;padding:.75rem .85rem;margin:.15rem 0 .75rem;font-size:.88rem;line-height:1.45;}
  .data-list {border-top:1px solid var(--line);margin-top:.15rem;}
  .data-row {display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:1rem;padding:.67rem .12rem;border-bottom:1px solid var(--line);}
  .data-row-title {color:var(--ink);font-size:.9rem;font-weight:730;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .data-row-meta {color:var(--muted);font-size:.71rem;margin-top:.18rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .data-row-value {color:var(--ink);font-size:.94rem;font-weight:800;text-align:right;}
  .data-row-label {color:#7b7f76;font-size:.54rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;text-align:right;margin-top:.15rem;}
  hr {border-color:var(--line)!important;margin:.75rem 0 1rem!important;}
  @media (max-width: 640px) {
    .block-container {padding:max(2.8rem,env(safe-area-inset-top)) .85rem calc(5rem + env(safe-area-inset-bottom));}
    [data-testid="stMetricValue"] {font-size: 1.15rem;}
    [data-testid="stMetric"] {padding:.6rem;}
    [data-testid="column"] {min-width: 0 !important;}
    [data-testid="stSegmentedControl"] label {font-size:.78rem; padding:.35rem .45rem;}
    div[data-testid="stVerticalBlockBorderWrapper"] {border-radius:7px;}
    .stat-grid {grid-template-columns:repeat(3,minmax(0,1fr));}
    .stat {padding:.58rem .52rem;}
    .stat-value {font-size:1rem;}
    .stat-label {font-size:.58rem;}
  }
</style>
""", unsafe_allow_html=True)

require_login()


def connect() -> None:
    st.markdown('<div class="app-kicker">Mobile fantasy command center</div>', unsafe_allow_html=True)
    st.title("Fantasy GM")
    st.caption("Clear roster decisions for dynasty and redraft Sleeper leagues.")
    if "league_choices" not in st.session_state:
        with st.form("find-leagues"):
            username = st.text_input("Sleeper username", placeholder="Your Sleeper username", autocomplete="username")
            submitted = st.form_submit_button("Find my leagues", type="primary", use_container_width=True)
        if not submitted:
            st.info("Enter your Sleeper username. No password is needed.")
            return
        if not username.strip():
            st.warning("Enter a Sleeper username to continue.")
            return
        try:
            with st.spinner("Finding your leagues…"):
                user = get_user(username)
                state = get_nfl_state()
                available = get_leagues(str(user["user_id"]), str(state["season"]))
            st.session_state.connection_username = username.strip()
            st.session_state.connection_season = str(state["season"])
            st.session_state.league_choices = available
            st.rerun()
        except ProviderError as exc:
            st.error(str(exc))
        return

    username = st.session_state.connection_username
    available = st.session_state.league_choices
    season = st.session_state.connection_season
    if not available:
        st.warning(f"No NFL leagues were found for {season}.")
        if st.button("Try another username", use_container_width=True):
            for key in ("league_choices", "connection_username", "connection_season"):
                st.session_state.pop(key, None)
            st.rerun()
        return
    labels = {f"{league.get('name', 'League')} · {league.get('season', season)} · {league.get('total_rosters', '?')} teams": str(league["league_id"]) for league in available}
    st.markdown("#### Choose a league")
    selected = st.radio("Available leagues", labels, label_visibility="collapsed")
    primary, secondary = st.columns([2, 1])
    if primary.button("Open league", type="primary", use_container_width=True):
        try:
            with st.spinner("Building your league workspace…"):
                st.session_state.league = import_league(username, labels[selected])
                st.session_state.username = username
            st.rerun()
        except ProviderError as exc:
            st.error(str(exc))
    if secondary.button("Back", use_container_width=True):
        for key in ("league_choices", "connection_username", "connection_season"):
            st.session_state.pop(key, None)
        st.rerun()


league = st.session_state.get("league")
if league is None:
    connect()
else:
    brand, refresh, action = st.columns([4, 1, 1], vertical_alignment="center")
    brand.markdown(f'<div class="app-brand">Fantasy GM</div><div class="app-context">{league.name} · {league.mode.title()}</div>', unsafe_allow_html=True)
    if refresh.button("↻", help="Refresh league data", use_container_width=True):
        try:
            with st.spinner("Refreshing league evidence…"):
                st.cache_data.clear()
                st.session_state.league = import_league(st.session_state.username, league.id)
            st.rerun()
        except ProviderError as exc:
            st.error(str(exc))
    if action.button("Switch", help="Switch Sleeper league", use_container_width=True):
        st.session_state.clear()
        st.rerun()
    if authentication_configured():
        account, logout = st.columns([4, 1])
        account.caption(f"Signed in as {st.user.get('email', st.user.get('name', 'user'))}")
        logout.button("Log out", on_click=st.logout)
    areas = {
        "Plan": {"Team plan": home, "Roster": rosters, "League": rankings},
        "Moves": {"Ideas": recommendations, "Waivers": waivers, "Evaluate": trade, "Journal": history},
        "Market": {"Values": values, "Signals": projections, "Data": diagnostics},
        "Draft": {"Draft room": draft},
    }
    if st.session_state.get("area") not in areas:
        st.session_state.area = "Plan"
    area = st.segmented_control("Primary navigation", list(areas), key="area", label_visibility="collapsed")
    pages = areas[area]
    if st.session_state.get("view") not in pages:
        st.session_state.view = next(iter(pages))
    if len(pages) > 1:
        page = st.pills("Page navigation", list(pages), key="view", label_visibility="collapsed")
    else:
        page = next(iter(pages))
        st.session_state.view = page
    pages[page](league)
