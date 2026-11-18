from __future__ import annotations

import streamlit as st

from python_app.providers import ProviderError, get_leagues, get_nfl_state, get_user, import_league
from python_app.views import diagnostics, draft, history, home, player_seeker, projections, rankings, recommendations, rosters, trade, values, waivers
from python_app.auth import authentication_configured, require_login

st.set_page_config(page_title="Fantasy GM", page_icon="🏈", layout="centered", initial_sidebar_state="collapsed")

APP_STATE_SCHEMA_VERSION = 16
if st.session_state.get("_app_state_schema_version") != APP_STATE_SCHEMA_VERSION:
    st.session_state.clear()
    st.session_state._app_state_schema_version = APP_STATE_SCHEMA_VERSION

if st.session_state.get("color_mode") not in {"Light", "Dark"}:
    active_streamlit_theme = getattr(st.context.theme, "type", None)
    st.session_state.color_mode = "Dark" if active_streamlit_theme == "dark" else "Light"

st.markdown("""
<style>
  :root {color-scheme:light;--ink:#10130f;--muted:#687066;--line:#d9dfd5;--panel:#ffffff;--canvas:#eef2eb;--accent:#b9f542;--accent-soft:#eaffbb;--violet:#6657d9;--violet-soft:#eeebff;--cyan:#087f8c;--cyan-soft:#e0f5f5;--positive:#16784a;--positive-soft:#e5f6ed;--warning:#a45b08;--warning-soft:#fff2da;--danger:#b9382f;--danger-soft:#feecea;--info:#315a75;--info-soft:#e8f1f6;}
  html,body,[class*="css"] {font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
  .stApp {background:radial-gradient(circle at 92% 3%,rgba(185,245,66,.29),transparent 25rem),radial-gradient(circle at -8% 31%,rgba(102,87,217,.12),transparent 24rem),radial-gradient(circle at 105% 72%,rgba(8,127,140,.10),transparent 28rem),linear-gradient(180deg,#f8faF4 0,var(--canvas) 30rem);color:var(--ink);}
  .block-container {max-width:800px;padding:3rem 1.35rem 6rem;}
  [data-testid="stHeader"] {height:2.5rem;background:rgba(245,248,240,.78);backdrop-filter:blur(18px);border-bottom:1px solid rgba(16,19,15,.07);}
  [data-testid="stElementContainer"][data-stale="true"] {display:none!important;}
  [data-testid="stMetric"] {background:transparent;border:0;border-radius:0;padding:.65rem;}
  [data-testid="stMetricLabel"] {font-size: .7rem; text-transform: uppercase; letter-spacing: .06em;}
  div[data-testid="stVerticalBlockBorderWrapper"] {background:linear-gradient(145deg,rgba(255,255,255,.97),rgba(247,250,243,.93));border:1px solid rgba(73,91,61,.14);border-radius:20px;box-shadow:0 12px 34px rgba(30,40,24,.07);overflow:hidden;transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease;}
  div[data-testid="stVerticalBlockBorderWrapper"]:has(.badge-row):hover {border-color:rgba(108,137,71,.35);box-shadow:0 18px 44px rgba(30,40,24,.11);transform:translateY(-1px);}
  div[data-testid="stVerticalBlockBorderWrapper"]:has(.deal-package) {border-top:4px solid var(--accent);box-shadow:0 14px 38px rgba(45,60,31,.10);}
  div[data-testid="stVerticalBlockBorderWrapper"] > div {padding:1rem 1.05rem;}
  [data-testid="stSegmentedControl"] {width: 100%;}
  [data-testid="stSegmentedControl"] > div {width: 100%;}
  [data-testid="stSegmentedControl"] > div {background:rgba(235,239,231,.82);border:1px solid rgba(100,114,92,.18);border-radius:14px;padding:4px;gap:3px;box-shadow:inset 0 1px 0 rgba(255,255,255,.7);}
  [data-testid="stSegmentedControl"] label {flex:1;justify-content:center;min-height:38px;border:0;border-radius:9px;color:#626a60;font-weight:720;transition:.16s ease;}
  [data-testid="stSegmentedControl"] label:has(input:checked) {color:var(--ink);background:#fff;box-shadow:0 3px 10px rgba(20,30,16,.10);}
  [data-testid="stPills"] {margin:.12rem 0 .55rem;}
  [data-testid="stPills"] button {border-radius:999px!important;font-size:.72rem!important;font-weight:760!important;min-height:34px!important;padding:.3rem .78rem!important;background:rgba(247,248,244,.78)!important;border-color:#d5dcd0!important;transition:background .15s ease,border-color .15s ease,transform .15s ease!important;}
  [data-testid="stPills"] button:hover {transform:translateY(-1px);}
  [data-testid="stPills"] button[aria-pressed="true"] {background:var(--accent-soft)!important;border-color:#b8d96f!important;color:#263d08!important;}
  [data-testid="stExpander"] {border:1px solid #d6ddd1;border-radius:12px;background:linear-gradient(120deg,rgba(255,255,255,.72),rgba(232,241,246,.48));overflow:hidden;}
  [data-baseweb="select"] > div {background:linear-gradient(135deg,#fff,#f5f7fb);border-color:#d2d9ce;border-radius:12px;min-height:48px;box-shadow:0 3px 12px rgba(20,30,16,.035);}
  [data-testid="stTextInput"] input {background:#fff;border-color:#d5dbd0;border-radius:12px;min-height:48px;box-shadow:0 3px 12px rgba(20,30,16,.035);}
  [data-testid="stMultiSelect"] [data-baseweb="select"] > div {min-height:52px;}
  .stButton > button,.stDownloadButton > button {border-radius:12px;font-weight:780;box-shadow:none;border-color:#cfd6ca;background:rgba(255,255,255,.7);color:var(--ink);transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease;}
  .stButton > button:hover,.stDownloadButton > button:hover {transform:translateY(-1px);box-shadow:0 8px 20px rgba(20,30,16,.09);}
  .stButton > button:hover,.stDownloadButton > button:hover {border-color:var(--ink);color:var(--ink);}
  .stButton > button[kind="primary"] {background:var(--ink);color:#fff;border:1px solid var(--ink);box-shadow:4px 4px 0 var(--accent);}
  button:focus-visible,input:focus-visible,textarea:focus-visible,[role="button"]:focus-visible {outline:3px solid var(--accent)!important;outline-offset:3px!important;box-shadow:0 0 0 5px rgba(185,245,66,.2)!important;}
  button, input, textarea, [role="button"] {min-height: 44px;}
  h1 {font-size:clamp(1.9rem,7vw,2.55rem)!important;letter-spacing:-.055em!important;margin-bottom:.15rem!important;font-weight:880!important;line-height:1.02!important;}
  h2, h3 {letter-spacing: -.02em !important;}
  .app-kicker {color:#4d5149;font-size:.64rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-bottom:.28rem;}
  .app-brand {font-size:1.08rem;font-weight:920;letter-spacing:-.045em;line-height:1.1;}
  .app-brand:before {content:"";display:inline-block;width:.55rem;height:.55rem;background:var(--accent);border:2px solid var(--ink);margin-right:.45rem;transform:rotate(45deg);}
  .app-context {color:#73776e;font-size:.68rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.2rem;}
  [data-testid="stHorizontalBlock"]:has(.app-brand) {align-items:center;gap:.42rem;}
  [data-testid="stHorizontalBlock"]:has(.app-brand) [data-testid="stButton"] button {min-height:36px!important;height:36px;padding:.35rem!important;border-radius:10px!important;box-shadow:none!important;}
  [data-testid="stHorizontalBlock"]:has(.app-brand) [data-testid="stButton"] button span {font-size:1.05rem!important;}
  .page-intro {padding:1.3rem 0 1.05rem;border-bottom:1px solid rgba(100,114,92,.13);margin-bottom:.45rem;}
  .page-intro h1 {margin:.05rem 0 .2rem;font-size:clamp(1.65rem,6vw,2rem);line-height:1.08;}
  .page-intro p {color:var(--muted);font-size:.86rem;line-height:1.4;margin:0;max-width:36rem;}
  .section-title {display:flex;align-items:center;gap:.55rem;margin:1.75rem 0 .65rem;color:#555e52;font-size:.64rem;font-weight:900;letter-spacing:.15em;text-transform:uppercase;}
  .section-title:after {content:"";height:1px;flex:1;background:linear-gradient(90deg,var(--line),transparent);}
  .stat-grid {display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:.3rem 0 .75rem;border-block:1px solid var(--line);}
  .stat {background:transparent;border:0;border-right:1px solid var(--line);border-radius:0;padding:.65rem .8rem;min-width:0;}
  .stat:last-child {border-right:0;}
  .stat-value {color:var(--ink);font-size:1.2rem;font-weight:850;line-height:1.1;overflow:hidden;text-overflow:ellipsis;}
  .stat-label {color:#71796f;font-size:.65rem;font-weight:820;letter-spacing:.075em;text-transform:uppercase;margin-top:.3rem;}
  .asset-card {padding:.05rem 0;}
  .asset-title {font-size:1.02rem;font-weight:860;color:var(--ink);line-height:1.25;letter-spacing:-.015em;}
  .asset-meta {color:var(--muted);font-size:.79rem;margin-top:.28rem;line-height:1.45;}
  .player-profile-hero {display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:.2rem 0 .75rem;}
  .player-profile-hero h2 {font-size:1.65rem;margin:.1rem 0 .18rem;line-height:1.05;}
  .player-profile-hero p {color:var(--muted);font-size:.8rem;margin:0;}
  .player-profile-status {flex:0 0 auto;border:1px solid var(--line);background:var(--accent-soft);color:var(--ink);border-radius:999px;padding:.3rem .62rem;font-size:.62rem;font-weight:850;letter-spacing:.07em;}
  .player-impact-note {display:flex;justify-content:space-between;gap:1rem;background:#edf4e4;border-left:4px solid #7ca52c;padding:.62rem .72rem;margin:.35rem 0 .75rem;color:#172011;font-size:.78rem;}
  .player-detail-list h3 {font-size:.92rem;margin:0 0 .42rem;}
  .player-detail-list > div {display:flex;justify-content:space-between;align-items:center;gap:.7rem;padding:.36rem 0;border-bottom:1px solid rgba(100,114,92,.12);font-size:.78rem;}
  .player-detail-list > div:last-child {border-bottom:0;}
  .player-detail-list > div span {color:var(--muted);}
  .player-detail-list > div strong {color:var(--ink);text-align:right;}
  .player-detail-list .source-row {font-size:.72rem;}
  .player-detail-list .market-disagreement.is-high {margin:.25rem 0;padding:.38rem .48rem;background:#fff2da;border:1px solid #e7c88f;border-radius:8px;}
  .player-detail-list .market-disagreement.is-high span,.player-detail-list .market-disagreement.is-high strong {color:#8c4e07;}
  [data-testid="stDialog"],[data-testid="stDialog"] > div,[data-testid="stDialog"] [data-baseweb="modal"],[data-testid="stDialog"] [role="dialog"] {background:#f7f8f4;color:#10130f;}
  [data-testid="stDialog"] .stat-grid {grid-template-columns:repeat(4,minmax(0,1fr));}
  [data-testid="stDialog"] .stat-value {color:#10130f!important;}
  [data-testid="stDialog"] .stat-label {color:#667061!important;}
  [data-testid="stDialog"] [data-testid="stExpander"] {background:#edf1eb;border-color:#cbd4c7;}
  [data-testid="stDialog"] [data-testid="stExpander"] summary,[data-testid="stDialog"] [data-testid="stExpander"] summary * {color:#172016!important;}
  [data-testid="stDialog"] button[aria-label="Close"],[data-testid="stDialog"] button[aria-label="Close"] svg {color:#253022!important;fill:#253022!important;opacity:1!important;}
  .signal {display:inline-block;border:1px solid var(--ink);background:var(--accent);color:var(--ink);border-radius:2px;padding:.2rem .42rem;font-size:.6rem;font-weight:850;letter-spacing:.06em;}
  .field-help {color:var(--muted);font-size:.76rem;margin:-.2rem 0 .45rem;}
  .insight {border-left:4px solid var(--accent);background:linear-gradient(90deg,var(--accent-soft),rgba(255,255,255,.88) 72%);padding:.75rem .85rem;margin:.15rem 0 .75rem;font-size:.88rem;line-height:1.45;}
  .badge-row {display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin-bottom:.82rem;}
  .ui-badge {display:inline-flex;align-items:center;border-radius:999px;padding:.25rem .52rem;font-size:.62rem;font-weight:880;letter-spacing:.065em;text-transform:uppercase;border:1px solid transparent;}
  .badge-accent {background:var(--accent-soft);color:#2e4b00;border-color:#cdea83;}
  .badge-neutral {background:var(--violet-soft);color:#5145af;border-color:#d9d3ff;}
  .badge-warning {background:var(--warning-soft);color:var(--warning);border-color:#f1d7a6;}
  .badge-danger {background:var(--danger-soft);color:var(--danger);border-color:#f4c9c5;}
  .deal-package {display:grid;grid-template-columns:minmax(0,1fr) 34px minmax(0,1fr);gap:.55rem;align-items:stretch;background:radial-gradient(circle at 100% 0,rgba(102,87,217,.24),transparent 45%),linear-gradient(135deg,#11150f,#18231d);color:#fff;border-radius:16px;padding:.78rem;margin:.9rem 0;box-shadow:inset 0 0 0 1px rgba(255,255,255,.07),0 10px 26px rgba(27,36,21,.14);}
  .deal-side {background:rgba(255,255,255,.065);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:.68rem;min-width:0;}
  .deal-side.receive {background:rgba(185,245,66,.11);border-color:rgba(185,245,66,.28);}
  .deal-label {font-size:.59rem;font-weight:850;letter-spacing:.12em;text-transform:uppercase;color:#aeb7a8;margin-bottom:.32rem;}
  .deal-side.receive .deal-label {color:#cffa76;}
  .deal-assets {font-size:.87rem;font-weight:760;line-height:1.45;overflow-wrap:anywhere;}
  .deal-arrow {display:flex;align-items:center;justify-content:center;color:var(--accent);font-size:1.15rem;font-weight:900;}
  .interactive-deal-marker,.deal-send-marker,.deal-receive-marker {display:none;}
  div[data-testid="stVerticalBlockBorderWrapper"]:has(.interactive-deal-marker) {background:radial-gradient(circle at 100% 0,rgba(102,87,217,.17),transparent 46%),linear-gradient(135deg,#11150f,#18231d);border-color:rgba(255,255,255,.08);box-shadow:0 10px 26px rgba(27,36,21,.12);}
  div[data-testid="stVerticalBlockBorderWrapper"]:has(.interactive-deal-marker) [data-testid="stCaptionContainer"] {color:#aeb7a8;font-size:.58rem;font-weight:850;letter-spacing:.09em;}
  .interactive-deal-arrow {display:flex;align-items:center;justify-content:center;color:var(--accent);font-size:1.2rem;font-weight:900;min-height:3rem;}
  [class*="st-key-dealplayer_send_"] button,[class*="st-key-dealplayer_receive_"] button,[class*="st-key-dealplayer-send-"] button,[class*="st-key-dealplayer-receive-"] button {min-height:54px!important;justify-content:flex-start!important;padding:.65rem .85rem!important;background:linear-gradient(135deg,#252d26,#202721)!important;border:1px solid #4b584d!important;border-radius:12px!important;color:#f8fbf5!important;box-shadow:0 7px 18px rgba(0,0,0,.2)!important;font-size:1.02rem!important;font-weight:880!important;letter-spacing:-.015em!important;}
  [class*="st-key-dealplayer_send_"] button,[class*="st-key-dealplayer-send-"] button {border-left:4px solid #8e82eb!important;}
  [class*="st-key-dealplayer_receive_"] button,[class*="st-key-dealplayer-receive-"] button {border-left:4px solid var(--accent)!important;background:linear-gradient(135deg,#293624,#202b22)!important;}
  [class*="st-key-dealplayer_send_"] button p,[class*="st-key-dealplayer_receive_"] button p,[class*="st-key-dealplayer-send-"] button p,[class*="st-key-dealplayer-receive-"] button p {color:inherit!important;font-size:inherit!important;font-weight:inherit!important;}
  [class*="st-key-dealplayer_send_"] button svg,[class*="st-key-dealplayer-send-"] button svg {color:#b8afff!important;}
  [class*="st-key-dealplayer_receive_"] button svg,[class*="st-key-dealplayer-receive-"] button svg {color:var(--accent)!important;}
  [class*="st-key-dealplayer_send_"] button:hover,[class*="st-key-dealplayer_receive_"] button:hover,[class*="st-key-dealplayer-send-"] button:hover,[class*="st-key-dealplayer-receive-"] button:hover {background:#344035!important;border-color:#8fa386!important;color:#fff!important;transform:translateY(-1px);}
  .decision-strip {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem;margin:.7rem 0;}
  .decision-tile {border:1px solid #d8ded3;background:linear-gradient(145deg,#f8faf5,#f0f5ea);border-radius:13px;padding:.72rem;min-width:0;}
  .decision-tile:nth-child(2) {background:linear-gradient(145deg,var(--violet-soft),#f7f5ff);border-color:#dcd7fa;}
  .decision-tile:nth-child(3) {background:linear-gradient(145deg,var(--cyan-soft),#f1fbfb);border-color:#c8e7e7;}
  .decision-strip.is-muted .decision-tile {filter:saturate(.42);opacity:.82;}
  .final-verdict {display:flex;align-items:flex-start;gap:.55rem;background:var(--danger-soft);border:1px solid #efc4c0;border-left:4px solid var(--danger);border-radius:10px;padding:.65rem .72rem;margin:.75rem 0 .55rem;color:var(--danger);font-size:.76rem;line-height:1.4;}
  .final-verdict strong {white-space:nowrap;font-weight:900;}
  .final-verdict span {color:#74413c;}
  .search-loading {display:flex;align-items:flex-start;gap:.75rem;background:linear-gradient(135deg,var(--panel),#edf3e8);border:1px solid var(--line);border-radius:14px;padding:.9rem 1rem;margin:.5rem 0;color:var(--ink);box-shadow:0 8px 24px rgba(25,35,22,.07);}
  .search-loading div {display:flex;flex-direction:column;gap:.2rem;min-width:0;}
  .search-loading strong {font-size:.84rem;font-weight:850;color:var(--ink);}
  .search-loading span:not(.search-spinner) {font-size:.75rem;line-height:1.4;color:var(--muted);}
  .search-spinner {flex:0 0 auto;width:1rem;height:1rem;margin-top:.08rem;border:2px solid #cbd5c4;border-top-color:var(--accent);border-radius:50%;animation:search-spin .8s linear infinite;}
  @keyframes search-spin {to {transform:rotate(360deg);}}
  .decision-value {font-size:.87rem;font-weight:850;line-height:1.2;overflow-wrap:anywhere;}
  .decision-label {font-size:.59rem;color:#747c71;font-weight:820;letter-spacing:.075em;text-transform:uppercase;margin-top:.3rem;}
  .ladder-map {display:grid;grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr) 24px minmax(0,1fr) 24px minmax(0,1fr);align-items:stretch;gap:.35rem;margin:.85rem 0 .65rem;}
  .ladder-node {position:relative;min-width:0;border:1px solid var(--line);border-radius:12px;padding:.72rem;background:linear-gradient(145deg,var(--panel),#f2f5ef);}
  .ladder-node.action {border-color:#b8d96f;background:linear-gradient(145deg,var(--accent-soft),var(--panel));}
  .ladder-node.conditional {border-color:#d8d1ff;background:linear-gradient(145deg,var(--violet-soft),var(--panel));}
  .ladder-node.final {border-color:#b9dedf;background:linear-gradient(145deg,var(--cyan-soft),var(--panel));}
  .ladder-kicker {font-size:.55rem;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.32rem;}
  .ladder-node.action .ladder-kicker {color:#4e720a;}.ladder-node.conditional .ladder-kicker {color:#5d51b4;}.ladder-node.final .ladder-kicker {color:#08727c;}
  .ladder-title {font-size:.77rem;font-weight:850;color:var(--ink);line-height:1.3;overflow-wrap:anywhere;}
  .ladder-meta {font-size:.65rem;color:var(--muted);line-height:1.4;margin-top:.25rem;overflow-wrap:anywhere;}
  .ladder-arrow {display:flex;align-items:center;justify-content:center;color:var(--accent);font-weight:950;font-size:1rem;}
  .ladder-callout {display:flex;justify-content:space-between;gap:.75rem;align-items:center;border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:11px;padding:.68rem .75rem;background:linear-gradient(90deg,rgba(185,245,66,.10),rgba(102,87,217,.07));margin:.45rem 0 .8rem;}
  .ladder-callout-copy {font-size:.73rem;color:var(--muted);line-height:1.4;}.ladder-callout-copy strong {display:block;color:var(--ink);font-size:.79rem;margin-bottom:.12rem;}
  .ladder-score {flex:0 0 auto;font-size:1.05rem;font-weight:900;color:var(--ink);}
  .risk-callout {border-radius:10px;padding:.62rem .72rem;margin:.55rem 0 .75rem;background:var(--warning-soft);color:#6e410b;border:1px solid #f0d5a3;font-size:.78rem;line-height:1.42;}
  .risk-callout strong {color:#8d4e05;}
  .home-status {display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;margin:.15rem 0 .8rem;}
  .home-status-primary {display:inline-flex;align-items:center;gap:.42rem;background:var(--accent-soft);color:#294500;border:1px solid #c7df8b;border-radius:999px;padding:.34rem .65rem;font-size:.68rem;font-weight:850;text-transform:uppercase;letter-spacing:.07em;}
  .home-status-primary:before {content:"";width:.42rem;height:.42rem;background:var(--positive);border-radius:50%;box-shadow:0 0 0 3px rgba(22,120,74,.12);}
  .home-status-secondary {color:var(--muted);font-size:.72rem;font-weight:720;}
  .gm-metrics {display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-block:1px solid var(--line);margin:.45rem 0 1.15rem;}
  .gm-metric {padding:.8rem .72rem;border-right:1px solid var(--line);min-width:0;}
  .gm-metric:last-child {border-right:0;}
  .gm-metric-value {font-size:1.16rem;font-weight:880;line-height:1.1;color:var(--ink);}
  .gm-metric-label {margin-top:.3rem;color:var(--muted);font-size:.58rem;font-weight:850;letter-spacing:.08em;text-transform:uppercase;}
  .gm-brief {position:relative;overflow:hidden;background:linear-gradient(135deg,var(--panel),#f2f7eb);border:1px solid var(--line);border-radius:16px;padding:1rem 1.05rem;margin:.45rem 0 .75rem;box-shadow:0 10px 28px rgba(30,40,24,.07);}
  .gm-brief:after {content:"";position:absolute;width:9rem;height:9rem;border-radius:50%;right:-5rem;top:-5rem;background:rgba(185,245,66,.19);}
  .gm-brief-kicker {color:var(--positive);font-size:.61rem;font-weight:900;letter-spacing:.12em;text-transform:uppercase;margin-bottom:.32rem;}
  .gm-brief-title {color:var(--ink);font-size:1.03rem;font-weight:880;margin-bottom:.3rem;}
  .gm-brief-copy {color:var(--muted);font-size:.81rem;line-height:1.48;max-width:37rem;}
  .gm-brief-action {border-top:1px solid var(--line);margin-top:.72rem;padding-top:.7rem;color:var(--ink);font-size:.82rem;line-height:1.42;}
  .gm-brief-action strong {color:var(--positive);}
  .strategy-grid {display:grid;grid-template-columns:1fr 1fr;gap:.65rem;margin:.5rem 0 .75rem;}
  .strategy-panel {border:1px solid var(--line);border-radius:14px;padding:.82rem;min-width:0;}
  .strategy-panel.protect {background:linear-gradient(145deg,var(--violet-soft),var(--panel));}
  .strategy-panel.shop {background:linear-gradient(145deg,var(--cyan-soft),var(--panel));}
  .strategy-label {font-size:.59rem;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.52rem;}
  .player-chips {display:flex;flex-wrap:wrap;gap:.36rem;}
  .player-chip {display:inline-flex;background:rgba(255,255,255,.58);border:1px solid rgba(80,90,78,.16);border-radius:999px;padding:.28rem .5rem;color:var(--ink);font-size:.68rem;font-weight:740;line-height:1.2;}
  .data-list {border-top:1px solid var(--line);margin-top:.15rem;}
  .data-row {display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:1rem;padding:.67rem .12rem;border-bottom:1px solid var(--line);}
  .data-row-title {color:var(--ink);font-size:.9rem;font-weight:730;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .data-row-meta {color:var(--muted);font-size:.71rem;margin-top:.18rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .data-row-value {color:var(--ink);font-size:.94rem;font-weight:800;text-align:right;}
  .data-row-label {color:#7b7f76;font-size:.54rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;text-align:right;margin-top:.15rem;}
  /* Compact product shell: the first control is the global nav, the second is local context. */
  .block-container > div > [data-testid="stVerticalBlock"] > [data-testid="stElementContainer"]:has([data-testid="stSegmentedControl"]):first-of-type {position:relative;z-index:4;}
  [data-testid="stSegmentedControl"] label {letter-spacing:-.01em;}
  [data-testid="stExpander"] summary {font-weight:740;}
  [data-testid="stExpander"] summary:hover {background:rgba(185,245,66,.055);}
  [data-testid="stCaptionContainer"] {line-height:1.5;}
  hr {border-color:var(--line)!important;margin:.75rem 0 1rem!important;}
  @media (max-width: 640px) {
    .block-container {padding:max(2.8rem,env(safe-area-inset-top)) .85rem calc(5rem + env(safe-area-inset-bottom));}
    [data-testid="stMetricValue"] {font-size: 1.15rem;}
    [data-testid="stMetric"] {padding:.6rem;}
    [data-testid="column"] {min-width: 0 !important;}
    [data-testid="stSegmentedControl"] label {font-size:.78rem; padding:.35rem .45rem;}
    div[data-testid="stVerticalBlockBorderWrapper"] {border-radius:15px;}
    .stat-grid {grid-template-columns:repeat(3,minmax(0,1fr));}
    .stat {padding:.58rem .52rem;}
    .stat-value {font-size:1rem;}
    .stat-label {font-size:.58rem;}
    .player-profile-hero {align-items:center;}
    .player-profile-hero h2 {font-size:1.35rem;}
    [data-testid="stDialog"] .stat-grid {grid-template-columns:repeat(2,minmax(0,1fr));}
    .deal-package {grid-template-columns:1fr;gap:.38rem;}
    .deal-arrow {height:22px;transform:rotate(90deg);}
    .interactive-deal-arrow {transform:rotate(90deg);}
    .decision-strip {grid-template-columns:1fr 1fr;}
    .ladder-map {display:flex;overflow-x:auto;padding-bottom:.25rem;scroll-snap-type:x proximity;}
    .ladder-node {flex:0 0 145px;scroll-snap-align:start;}.ladder-arrow {flex:0 0 18px;}
    .gm-metrics {grid-template-columns:1fr 1fr;}
    .gm-metric:nth-child(2) {border-right:0;}
    .gm-metric:nth-child(-n+2) {border-bottom:1px solid var(--line);}
    .strategy-grid {grid-template-columns:1fr;}
    .final-verdict {flex-direction:column;gap:.2rem;}
    .final-verdict strong {white-space:normal;}
    .badge-row {gap:.3rem;}
    .ui-badge {font-size:.56rem;padding:.22rem .42rem;}
    .page-intro {padding:1rem 0 .8rem;}
    h1 {font-size:clamp(1.85rem,10vw,2.25rem)!important;}
  }
</style>
""", unsafe_allow_html=True)

DARK_THEME_CSS = """
  :root {color-scheme:dark;--ink:#f2f6ed;--muted:#aab3a4;--line:#354038;--panel:#182019;--canvas:#101510;--accent:#b9f542;--accent-soft:#2b3b18;--violet-soft:#282442;--cyan-soft:#183638;--positive-soft:#17382a;--warning-soft:#3b2c17;--danger-soft:#402321;--info-soft:#1c303c;--text-color:#f2f6ed;--background-color:#101510;--secondary-background-color:#182019;}
  .stApp {background:radial-gradient(circle at 92% 3%,rgba(185,245,66,.13),transparent 25rem),radial-gradient(circle at -8% 31%,rgba(112,96,235,.17),transparent 24rem),radial-gradient(circle at 105% 72%,rgba(10,148,160,.13),transparent 28rem),linear-gradient(180deg,#151b14 0,var(--canvas) 30rem);color:var(--ink);}
  .stApp p,.stApp li,.stApp label,.stApp [data-testid="stMarkdownContainer"],.stApp [data-testid="stWidgetLabel"] {color:var(--ink);}
  .stApp [data-testid="stCaptionContainer"],.stApp [data-testid="stCaptionContainer"] p {color:#aeb8aa!important;opacity:1!important;}
  .stApp [data-testid="stAlert"],.stApp [data-testid="stAlert"] > div,.stApp [data-baseweb="notification"] {background:#1d2b27!important;background-image:none!important;border-color:#3c5149!important;color:#eef5ec!important;}
  .stApp [data-testid="stAlert"] p,.stApp [data-testid="stAlert"] span,.stApp [data-testid="stAlert"] div,.stApp [data-baseweb="notification"] p,.stApp [data-baseweb="notification"] span {color:#eef5ec!important;opacity:1!important;}
  .stApp [data-testid="stAlert"] svg,.stApp [data-baseweb="notification"] svg {fill:var(--accent)!important;color:var(--accent)!important;}
  .stApp [data-testid="stStatusWidget"],.stApp [data-testid="stStatusWidget"] > div,.stApp [data-testid="stStatusWidget"] details,.stApp [data-testid="stStatusWidget"] summary,.stApp [data-testid="stStatusWidget"] [role="button"] {background:#18231f!important;background-image:none!important;border-color:#3b4d45!important;color:#eef5ec!important;}
  .stApp [data-testid="stStatusWidget"] * {background-color:transparent!important;background-image:none!important;}
  .stApp [data-testid="stStatusWidget"] p,.stApp [data-testid="stStatusWidget"] span,.stApp [data-testid="stStatusWidget"] div {color:#eef5ec!important;opacity:1!important;}
  .stApp [data-testid="stStatusWidget"] svg {color:var(--accent)!important;}
  .stApp [role="radiogroup"] label,.stApp [role="radiogroup"] label p,.stApp [data-testid="stRadio"] label,.stApp [data-testid="stRadio"] label p {color:#e9eee5!important;opacity:1!important;}
  .stApp input,.stApp textarea,.stApp input::placeholder,.stApp textarea::placeholder {color:var(--ink)!important;-webkit-text-fill-color:var(--ink);opacity:1;}
  .stApp input::placeholder,.stApp textarea::placeholder {color:#8f9a8b!important;-webkit-text-fill-color:#8f9a8b;}
  .stApp [data-baseweb="select"] span,.stApp [data-baseweb="select"] div {color:var(--ink);}
  .stApp [data-baseweb="menu"] li,.stApp [role="option"] {color:var(--ink)!important;background:#202820;}
  .stApp [data-baseweb="menu"] li:hover,.stApp [role="option"]:hover {background:#303b31;}
  .stApp button:not([kind="primary"]) {background-color:#202920!important;background-image:none!important;color:var(--ink)!important;border-color:#435044!important;}
  .stApp button:not([kind="primary"]) > div,.stApp button:not([kind="primary"]) p,.stApp button:not([kind="primary"]) span {color:inherit!important;}
  .stApp button:not([kind="primary"]):hover {background-color:#2d382e!important;color:#fff!important;border-color:#71836f!important;}
  .stApp button[aria-pressed="true"],.stApp button[aria-checked="true"],.stApp button[data-state="on"] {background-color:var(--accent-soft)!important;color:#dafa9a!important;border-color:#6d8e32!important;}
  .stApp [data-testid="stTooltipIcon"],.stApp [data-testid="stTooltipIcon"] button,.stApp button[aria-label*="help" i],.stApp button[aria-label*="tooltip" i] {background:transparent!important;border:0!important;box-shadow:none!important;color:#9aa595!important;min-height:0!important;padding:0!important;}
  .stApp [data-testid="stTooltipIcon"] button:hover,.stApp button[aria-label*="help" i]:hover,.stApp button[aria-label*="tooltip" i]:hover {background:transparent!important;color:var(--accent)!important;}
  .stApp [data-testid="stTooltipIcon"] button > div,.stApp button[aria-label*="help" i] > div,.stApp button[aria-label*="tooltip" i] > div {background:transparent!important;}
  [data-testid="stHeader"] {background:rgba(16,21,16,.78);border-bottom-color:rgba(255,255,255,.08);}
  [data-testid="stToolbar"] {color:var(--ink);}
  div[data-testid="stVerticalBlockBorderWrapper"] {background:linear-gradient(145deg,rgba(28,37,29,.98),rgba(20,28,22,.96));border-color:#344038;box-shadow:0 14px 38px rgba(0,0,0,.22);}
  [data-testid="stSegmentedControl"] > div {background:linear-gradient(90deg,#242d25,#29263b)!important;border-color:#3a453d!important;}
  [data-testid="stSegmentedControl"] button,[data-testid="stSegmentedControl"] button > div {background-color:#202820!important;background-image:none!important;color:#dfe6db!important;}
  [data-testid="stSegmentedControl"] label {color:#aeb7aa!important;background:#202820!important;border-color:#3b463d!important;}
  [data-testid="stSegmentedControl"] label span,[data-testid="stSegmentedControl"] label p {color:inherit!important;}
  [data-testid="stSegmentedControl"] label:has(input:checked) {color:#15200e!important;background:var(--accent)!important;border-color:var(--accent)!important;box-shadow:0 3px 12px rgba(0,0,0,.25)!important;}
  [data-testid="stSegmentedControl"] label:hover {color:var(--ink)!important;background:#303b31!important;}
  [data-testid="stSegmentedControl"] label:has(input:checked):hover {color:#15200e!important;background:#c7fa5d!important;}
  [data-testid="stPills"] button {background-color:#202921!important;background-image:none!important;border-color:#3a463c!important;color:#cbd3c8!important;}
  [data-testid="stPills"] button > div {background-color:transparent!important;color:inherit!important;}
  [data-testid="stPills"] button p,[data-testid="stPills"] button span {color:inherit!important;}
  [data-testid="stPills"] button:hover {background-color:#303b31!important;border-color:#59685b!important;color:#fff!important;}
  [data-testid="stPills"] button[aria-pressed="true"] {background-color:var(--accent-soft)!important;border-color:#6d8e32!important;color:#dafa9a!important;}
  [data-testid="stRadio"] label {width:100%;padding:.48rem .62rem!important;border:1px solid transparent!important;border-radius:10px!important;transition:background .14s ease,border-color .14s ease;}
  [data-testid="stRadio"] label:hover {background:#1d271e!important;border-color:#344237!important;}
  [data-testid="stRadio"] label:has(input:checked) {background:linear-gradient(90deg,#2b3b18,#213020)!important;border-color:#72913a!important;box-shadow:inset 3px 0 0 var(--accent)!important;}
  [data-testid="stRadio"] label:has(input:checked) p {color:#edffd0!important;font-weight:780!important;}
  [data-testid="stRadio"] label:has(input:checked) [role="radio"] {background-color:var(--accent)!important;border-color:var(--accent)!important;}
  [data-testid="stExpander"] {border-color:#354139;background:linear-gradient(120deg,rgba(27,36,28,.94),rgba(28,38,45,.72));}
  [data-baseweb="select"] > div,[data-testid="stTextInput"] input {background:linear-gradient(135deg,#202820,#242a32);border-color:#3b463e;color:var(--ink);}
  [data-baseweb="popover"],[data-baseweb="menu"] {background:#202820;color:var(--ink);}
  .stButton > button,.stDownloadButton > button {background-color:#202920!important;background-image:none!important;color:var(--ink)!important;border-color:#435044!important;}
  [data-testid="stButton"] button,[data-testid="stButton"] button > div,[data-testid="stDownloadButton"] button,[data-testid="stDownloadButton"] button > div {background-color:#202920!important;background-image:none!important;color:var(--ink)!important;border-color:#435044!important;}
  .stButton > button p,.stButton > button span,.stDownloadButton > button p,.stDownloadButton > button span {color:inherit!important;opacity:1!important;}
  .stButton > button:hover,.stDownloadButton > button:hover {background-color:#2d382e!important;color:#fff!important;border-color:var(--accent)!important;}
  .stButton > button[kind="primary"] {background-color:var(--accent)!important;color:#11160e!important;border-color:var(--accent)!important;box-shadow:4px 4px 0 #526929!important;}
  [data-testid="stButton"] button[kind="primary"],[data-testid="stButton"] button[kind="primary"] > div {background-color:var(--accent)!important;color:#11160e!important;border-color:var(--accent)!important;}
  .stButton > button[kind="primary"] p,.stButton > button[kind="primary"] span {color:#11160e!important;}
  .stButton > button:disabled,.stDownloadButton > button:disabled {background-color:#1a211b!important;color:#788276!important;border-color:#313a32!important;opacity:.7;}
  .app-kicker,.section-title {color:#9da998;}
  .app-context,.page-intro p,.asset-meta,.field-help {color:var(--muted);}
  .app-brand:before {border-color:var(--ink);}
  .stat-label,.decision-label,.data-row-meta,.data-row-label {color:#9ba697;}
  .insight {background:linear-gradient(90deg,var(--accent-soft),rgba(26,35,27,.92) 72%);}
  .badge-accent {background:#31451a;color:#d8fa95;border-color:#536f29;}
  .badge-neutral {background:var(--violet-soft);color:#c8c1ff;border-color:#49436c;}
  .badge-warning {background:var(--warning-soft);color:#f0bd73;border-color:#624b27;}
  .badge-danger {background:var(--danger-soft);color:#f3aaa4;border-color:#6b3935;}
  .decision-tile {background:linear-gradient(145deg,#202920,#263022);border-color:#3b473c;}
  .decision-tile:nth-child(2) {background:linear-gradient(145deg,var(--violet-soft),#302b49);border-color:#484267;}
  .decision-tile:nth-child(3) {background:linear-gradient(145deg,var(--cyan-soft),#203f40);border-color:#34595a;}
  .final-verdict {background:#3b2221;border-color:#67403c;color:#ffaaa3;}
  .final-verdict span {color:#e7bbb7;}
  .search-loading {background:linear-gradient(135deg,#18231f,#1a2829);border-color:#3b4d45;box-shadow:0 10px 28px rgba(0,0,0,.18);}
  .search-loading strong {color:#f1f6ee;}
  .search-loading span:not(.search-spinner) {color:#b3beb0;}
  .search-spinner {border-color:#4a594d;border-top-color:var(--accent);}
  .home-status-primary {background:#2c4018;color:#dafa9a;border-color:#526d2b;}
  .gm-brief {background:linear-gradient(135deg,#1b251c,#202c21);border-color:#354238;box-shadow:0 12px 30px rgba(0,0,0,.18);}
  .gm-brief-kicker,.gm-brief-action strong {color:var(--accent);}
  .player-chip {background:rgba(10,16,11,.36);border-color:rgba(220,230,218,.14);}
  .risk-callout {background:var(--warning-soft);color:#efc47e;border-color:#604a29;}
  .risk-callout strong {color:#ffd18a;}
  [data-testid="stDialog"],[data-testid="stDialog"] > div,[data-testid="stDialog"] [data-baseweb="modal"],[data-testid="stDialog"] [role="dialog"] {background:#182019!important;color:#f2f6ed!important;}
  [data-testid="stDialog"] [role="dialog"] p,[data-testid="stDialog"] [role="dialog"] li,[data-testid="stDialog"] [role="dialog"] h1,[data-testid="stDialog"] [role="dialog"] h2,[data-testid="stDialog"] [role="dialog"] h3,[data-testid="stDialog"] [role="dialog"] [data-testid="stMarkdownContainer"] {color:#f2f6ed!important;}
  [data-testid="stDialog"] .stat-value {color:#f2f6ed!important;}
  [data-testid="stDialog"] .stat-label,[data-testid="stDialog"] [data-testid="stCaptionContainer"],[data-testid="stDialog"] [data-testid="stCaptionContainer"] p {color:#b8c2b4!important;opacity:1!important;}
  [data-testid="stDialog"] .player-profile-status {background:#2b3b18;color:#dafa9a;border-color:#526d2b;}
  [data-testid="stDialog"] .player-impact-note {background:#23331a;color:#e9f8d6;border-color:var(--accent);}
  [data-testid="stDialog"] .player-detail-list h3,[data-testid="stDialog"] .player-detail-list > div strong {color:#f2f6ed!important;}
  [data-testid="stDialog"] .player-detail-list > div span {color:#b8c2b4!important;}
  [data-testid="stDialog"] .player-detail-list > div {border-color:#354038;}
  [data-testid="stDialog"] .player-detail-list .market-disagreement.is-high {background:#3b2c17;border-color:#725323;}
  [data-testid="stDialog"] .player-detail-list .market-disagreement.is-high span,[data-testid="stDialog"] .player-detail-list .market-disagreement.is-high strong {color:#ffd18a!important;}
  [data-testid="stDialog"] button[aria-label="Close"],[data-testid="stDialog"] button[aria-label="Close"] svg {color:#f2f6ed!important;fill:#f2f6ed!important;opacity:1!important;}
  [data-testid="stDialog"] button[aria-label="Close"]:hover {background:#2d382e!important;}
  [data-testid="stDialog"] [data-testid="stExpander"] {background:#202920!important;border-color:#3b473c!important;}
  [data-testid="stDialog"] [data-testid="stExpander"] summary,[data-testid="stDialog"] [data-testid="stExpander"] summary * {color:#f2f6ed!important;background:transparent!important;}
  [data-testid="stDialog"] button:not([aria-label*="Close"]) {background:#202920!important;color:#f2f6ed!important;border-color:#435044!important;}
  .data-row-title,.data-row-value,.asset-title,.stat-value {color:var(--ink);}
  hr {border-color:var(--line)!important;}
"""

if st.session_state.color_mode == "Dark":
    st.markdown(f"<style>{DARK_THEME_CSS}</style>", unsafe_allow_html=True)

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
    brand, theme, refresh, action = st.columns([7, .55, .55, .55], vertical_alignment="center")
    brand.markdown(f'<div class="app-brand">Fantasy GM</div><div class="app-context">{league.name} · {league.mode.title()}</div>', unsafe_allow_html=True)
    theme_icons = {"Light": ":material/light_mode:", "Dark": ":material/dark_mode:"}
    if theme.button(theme_icons[st.session_state.color_mode], help=f"Theme: {st.session_state.color_mode}. Click to change.", use_container_width=True):
        st.session_state.color_mode = "Light" if st.session_state.color_mode == "Dark" else "Dark"
        st.rerun()
    if refresh.button(":material/refresh:", help="Refresh league data", use_container_width=True):
        try:
            with st.spinner("Refreshing league evidence…"):
                import_league.clear(st.session_state.username, league.id)
                st.session_state.league = import_league(st.session_state.username, league.id)
            st.rerun()
        except ProviderError as exc:
            st.error(str(exc))
    if action.button(":material/swap_horiz:", help="Switch league", use_container_width=True):
        # Keep the connected Sleeper account and fetched league list so this
        # returns to league selection—not all the way back to username entry.
        st.session_state.pop("league", None)
        for key in (
            "area", "view", "_trade_finder_cache", "_goal_directed_cache",
            "_waiver_recommendation_cache",
        ):
            st.session_state.pop(key, None)
        st.rerun()
    if authentication_configured():
        account, logout = st.columns([4, 1])
        account.caption(f"Signed in as {st.user.get('email', st.user.get('name', 'user'))}")
        logout.button("Log out", on_click=st.logout)
    areas = {
        "Plan": {"Team plan": home, "Roster": rosters, "League": rankings},
        "Moves": {"Upgrade": recommendations, "Target": player_seeker, "Waivers": waivers, "Evaluate": trade, "Journal": history},
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
