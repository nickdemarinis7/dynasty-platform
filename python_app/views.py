from __future__ import annotations

import csv
import io
import time
import uuid

import streamlit as st

from .models import League, Roster
from .analytics import build_contexts, compute_projections, evaluate_trade, optimize_lineup
from .recommendations import generate_recommendations
from .draft import load_draft_snapshot
from .providers import ProviderError
from .auth import current_user_id
from .storage import StorageError, delete_trade, durable_storage_configured, load_trades, save_trade


def _load_recommendation(idea: object) -> None:
    for key in ("trade_team_a", "trade_team_b", "trade_a_players", "trade_b_players", "trade_a_picks", "trade_b_picks"):
        st.session_state.pop(key, None)
    st.session_state.trade_prefill = idea
    st.session_state.page = "Trade"


def _team_label(roster: Roster, league: League) -> str:
    return f"{roster.team_name}{' · My team' if roster.team_id == league.my_team_id else ''}"


def home(league: League) -> None:
    st.title(league.name)
    st.caption(f"{league.season} · {league.mode.title()} · {league.team_count} teams")
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    left, middle, right = st.columns(3)
    left.metric("Roster value", f"{my_team.total_value:,}")
    middle.metric("Starter core", f"{my_team.starter_value:,}")
    right.metric("Average age", f"{my_team.average_age:.1f}" if my_team.average_age else "—")
    if league.values_status != "live":
        st.warning("FantasyCalc values are temporarily unavailable. Players remain visible, but value analysis is disabled rather than estimated.")
    st.subheader("League format")
    st.write(" · ".join(filter(None, [league.scoring.upper(), "Superflex" if league.superflex else "1QB", "TE Premium" if league.te_premium else None])))


def rosters(league: League) -> None:
    st.title("Rosters")
    options = {_team_label(roster, league): roster for roster in league.rosters}
    selected = options[st.selectbox("Team", options, index=next((i for i, roster in enumerate(options.values()) if roster.team_id == league.my_team_id), 0))]
    st.caption(f"{selected.owner_name} · {len(selected.players)} players · {len(selected.draft_picks)} picks · Value {selected.total_value:,}")
    lineup = optimize_lineup(selected.players, league)
    with st.expander(f"Best lineup · {lineup.projected_points:.1f} estimated PPG"):
        for player in lineup.starters:
            st.write(f"**{player.position}** · {player.name} · {player.team}")
    position = st.segmented_control("Position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL")
    players = [player for player in selected.players if position == "ALL" or player.position == position]
    for player in sorted(players, key=lambda item: item.value, reverse=True):
        with st.container(border=True):
            name, value = st.columns([3, 1])
            name.markdown(f"**{player.name}**")
            name.caption(f"{player.position} · {player.team} · Age {player.age or '—'}{f' · {player.injury_status.upper()}' if player.injury_status else ''}")
            value.metric("Value", player.value if league.values_status == "live" else "—")
    if selected.draft_picks:
        with st.expander(f"Draft capital · {len(selected.draft_picks)} picks"):
            for pick in selected.draft_picks:
                owner_note = "" if pick.original_owner == selected.team_id else f" · via Team {pick.original_owner}"
                st.write(f"**{pick.label}**{owner_note} · Value {pick.value}")


def rankings(league: League) -> None:
    st.title("Power Rankings")
    st.caption("Market-value snapshot; lineup and projection scoring will be added during engine parity migration.")
    ranked = sorted(league.rosters, key=lambda roster: roster.total_value, reverse=True)
    contexts = build_contexts(league)
    for rank, roster in enumerate(ranked, 1):
        with st.container(border=True):
            heading, total = st.columns([3, 1])
            heading.markdown(f"**#{rank} · {_team_label(roster, league)}**")
            heading.caption(f"{roster.owner_name} · {contexts[roster.team_id].window} · Avg age {roster.average_age:.1f}")
            total.metric("Total", roster.total_value if league.values_status == "live" else "—")


def values(league: League) -> None:
    st.title("Player Values")
    query = st.text_input("Search", placeholder="Player or NFL team")
    position = st.segmented_control("Position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="values_position")
    unique_players = {player.id: player for roster in league.rosters for player in roster.players}.values()
    filtered = [
        player for player in unique_players
        if (position == "ALL" or player.position == position)
        and (not query or query.lower() in player.name.lower() or query.lower() in player.team.lower())
    ]
    for rank, player in enumerate(sorted(filtered, key=lambda item: item.value, reverse=True), 1):
        row = st.container(border=True)
        name, value = row.columns([3, 1])
        name.markdown(f"**#{rank} {player.name}**")
        name.caption(f"{player.position} · {player.team} · Age {player.age or '—'}")
        value.metric("Value", player.value if league.values_status == "live" else "—")


def projections(league: League) -> None:
    st.title("Edge Intelligence")
    st.caption(f"Week {league.current_week} · production, role, and {'season' if league.mode == 'redraft' else 'dynasty trajectory'}")
    position = st.segmented_control("Position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="edge_position")
    recommendation = st.selectbox("Signal", ["ALL", "STRONG BUY", "BUY", "HOLD", "SELL", "STRONG SELL"])
    results = [item for item in compute_projections(league) if (position == "ALL" or item.player.position == position) and (recommendation == "ALL" or item.recommendation == recommendation)]
    if not league.player_stats:
        st.warning("Season production is unavailable; results currently use neutral production and role scores.")
    for item in results:
        with st.container(border=True):
            heading, signal = st.columns([3, 1])
            heading.markdown(f"**{item.player.name}**")
            heading.caption(f"{item.player.position} · {item.player.team} · Age {item.player.age or '—'}")
            signal.markdown(f"**{item.recommendation}**")
            edge, delta, fppg = st.columns(3)
            edge.metric("Edge", item.edge_score)
            delta.metric("vs market", f"{item.edge_delta:+d}")
            fppg.metric("FPPG", f"{item.fppg:.1f}" if item.fppg is not None else "—")
            if item.signals:
                with st.expander("Why"):
                    for signal_text in item.signals:
                        st.write(f"• {signal_text}")


def recommendations(league: League) -> None:
    st.title("Trade Finder")
    st.caption("Executable ideas that pass ownership, fairness, team-fit, and lineup gates")
    position = st.segmented_control("Target position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="recommendation_position")
    ideas = generate_recommendations(league)
    if position != "ALL":
        ideas = [idea for idea in ideas if idea.receive_players and idea.receive_players[0].position == position]
    if not ideas:
        st.info("No recommendation currently passes every quality gate. Try another position or refresh league data; the app will not invent a bad trade to fill this screen.")
        return
    for idea in ideas:
        with st.container(border=True):
            heading, score = st.columns([3, 1])
            heading.markdown(f"**{idea.kind} · {idea.partner.team_name}**")
            heading.caption(idea.reason)
            score.metric("Quality", f"{idea.score}/100")
            sends = [player.name for player in idea.send_players] + [pick.label for pick in idea.send_picks]
            receives = [player.name for player in idea.receive_players] + [pick.label for pick in idea.receive_picks]
            st.write(f"**Send:** {', '.join(sends) or 'Nothing'}")
            st.write(f"**Receive:** {', '.join(receives) or 'Nothing'}")
            market, lineup, fit = st.columns(3)
            market.metric("Market", f"{idea.evaluation.fairness:+.1f}%")
            lineup.metric("Lineup", f"{idea.evaluation.lineup_a.points_gained:+.1f}")
            fit.metric("Offer fit", f"{idea.evaluation.acceptance_score}/100")
            st.button("Open in Trade Simulator", key=f"open-{idea.partner.team_id}-{sends}-{receives}", use_container_width=True, on_click=_load_recommendation, args=(idea,))


def trade(league: League) -> None:
    st.title("Trade Simulator")
    st.caption("Market fairness plus estimated starting-lineup impact")
    if league.values_status != "live":
        st.warning("Trade analysis requires current market values. Refresh the league when FantasyCalc is available.")
        return
    labels = {_team_label(roster, league): roster for roster in league.rosters}
    my_index = next((index for index, roster in enumerate(labels.values()) if roster.team_id == league.my_team_id), 0)
    prefill = st.session_state.get("trade_prefill")
    team_a_label = st.selectbox("Your team", labels, index=my_index, key="trade_team_a")
    opponents = {label: roster for label, roster in labels.items() if roster.team_id != labels[team_a_label].team_id}
    partner_index = 0
    if prefill:
        partner_index = next((index for index, roster in enumerate(opponents.values()) if roster.team_id == prefill.partner.team_id), 0)
    team_b_label = st.selectbox("Trade partner", opponents, index=partner_index, key="trade_team_b")
    team_a, team_b = labels[team_a_label], opponents[team_b_label]
    a_options = {f"{player.name} · {player.position} · {player.value}": player for player in sorted(team_a.players, key=lambda item: item.value, reverse=True)}
    b_options = {f"{player.name} · {player.position} · {player.value}": player for player in sorted(team_b.players, key=lambda item: item.value, reverse=True)}
    prefill_a_ids = {player.id for player in prefill.send_players} if prefill and team_b.team_id == prefill.partner.team_id else set()
    prefill_b_ids = {player.id for player in prefill.receive_players} if prefill and team_b.team_id == prefill.partner.team_id else set()
    a_defaults = [label for label, player in a_options.items() if player.id in prefill_a_ids]
    b_defaults = [label for label, player in b_options.items() if player.id in prefill_b_ids]
    a_selected = st.multiselect(f"{team_a.team_name} sends", a_options, default=a_defaults, key="trade_a_players")
    b_selected = st.multiselect(f"{team_b.team_name} sends", b_options, default=b_defaults, key="trade_b_players")
    a_pick_options = {f"{pick.label} · via Team {pick.original_owner} · {pick.value}": pick for pick in team_a.draft_picks}
    b_pick_options = {f"{pick.label} · via Team {pick.original_owner} · {pick.value}": pick for pick in team_b.draft_picks}
    if league.mode != "redraft":
        prefill_a_picks = {(pick.year, pick.round, pick.original_owner) for pick in prefill.send_picks} if prefill else set()
        prefill_b_picks = {(pick.year, pick.round, pick.original_owner) for pick in prefill.receive_picks} if prefill else set()
        a_pick_defaults = [label for label, pick in a_pick_options.items() if (pick.year, pick.round, pick.original_owner) in prefill_a_picks]
        b_pick_defaults = [label for label, pick in b_pick_options.items() if (pick.year, pick.round, pick.original_owner) in prefill_b_picks]
        a_picks = st.multiselect(f"{team_a.team_name} sends picks", a_pick_options, default=a_pick_defaults, key="trade_a_picks")
        b_picks = st.multiselect(f"{team_b.team_name} sends picks", b_pick_options, default=b_pick_defaults, key="trade_b_picks")
    else:
        a_picks, b_picks = [], []
    if not (a_selected or b_selected or a_picks or b_picks):
        st.info("Select players or picks to evaluate a trade.")
        return
    result = evaluate_trade(
        team_a, team_b,
        [a_options[key] for key in a_selected], [b_options[key] for key in b_selected], league,
        [a_pick_options[key] for key in a_picks], [b_pick_options[key] for key in b_picks],
    )
    st.subheader(result.verdict)
    left, right = st.columns(2)
    left.metric(f"{team_a.team_name} sends", f"{result.team_a_gives:.1f}")
    right.metric(f"{team_b.team_name} sends", f"{result.team_b_gives:.1f}")
    st.metric("Value difference for your team", f"{result.difference_for_a:+.1f}", f"{result.fairness:+.1f}%")
    context_a, context_b = build_contexts(league)[team_a.team_id], build_contexts(league)[team_b.team_id]
    fit_left, fit_right = st.columns(2)
    fit_left.metric(f"{context_a.window} fit", f"{result.fit_a:+.1f}")
    fit_right.metric(f"{context_b.window} fit", f"{result.fit_b:+.1f}")
    st.progress(result.acceptance_score / 100, text=f"Offer-fit score for {team_b.team_name}: {result.acceptance_score}/100")
    st.caption("Offer fit is a roster-context heuristic, not a calibrated probability that a manager accepts.")
    st.subheader("Lineup impact")
    left, right = st.columns(2)
    left.metric(team_a.team_name, f"{result.lineup_a.points_gained:+.1f} PPG", result.lineup_a.recommendation)
    right.metric(team_b.team_name, f"{result.lineup_b.points_gained:+.1f} PPG", result.lineup_b.recommendation)
    if b_selected and not result.lineup_a.received_player_starts:
        st.warning("The primary return does not currently crack your optimized starting lineup.")
    if st.button("Save trade", type="primary", use_container_width=True):
        saved_trade = {
            "id": str(uuid.uuid4()), "saved_at": int(time.time()), "league": league.name,
            "team_a": team_a.team_name, "team_b": team_b.team_name,
            "sends": ", ".join(a_selected + a_picks), "receives": ", ".join(b_selected + b_picks),
            "fairness": result.fairness, "lineup_change": result.lineup_a.points_gained,
            "offer_fit": result.acceptance_score, "verdict": result.verdict,
        }
        try:
            save_trade(current_user_id(), saved_trade)
            st.success("Trade saved permanently." if durable_storage_configured() else "Trade saved for this session.")
        except StorageError as exc:
            st.error(str(exc))


def history(league: League) -> None:
    st.title("Saved Trades")
    st.caption("Synced to your account." if durable_storage_configured() else "Session history can be exported before the Streamlit session ends.")
    try:
        saved = load_trades(current_user_id())
    except StorageError as exc:
        st.error(str(exc))
        return
    if not saved:
        st.info("No saved trades yet. Evaluate a deal in the Trade Simulator and tap Save trade.")
        return
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=list(saved[0].keys()))
    writer.writeheader()
    writer.writerows(saved)
    st.download_button("Export CSV", output.getvalue(), file_name=f"{league.name}-trades.csv", mime="text/csv", use_container_width=True)
    for index, item in enumerate(saved):
        with st.container(border=True):
            st.markdown(f"**{item['team_a']} ↔ {item['team_b']}**")
            st.caption(item["verdict"])
            st.write(f"**Send:** {item['sends'] or 'Nothing'}")
            st.write(f"**Receive:** {item['receives'] or 'Nothing'}")
            market, lineup, fit = st.columns(3)
            market.metric("Market", f"{item['fairness']:+.1f}%")
            lineup.metric("Lineup", f"{item['lineup_change']:+.1f}")
            fit.metric("Offer fit", f"{item['offer_fit']}/100")
            if st.button("Remove", key=f"remove-trade-{item['saved_at']}-{index}"):
                try:
                    delete_trade(current_user_id(), str(item["id"]))
                    st.rerun()
                except StorageError as exc:
                    st.error(str(exc))


@st.fragment(run_every=15)
def draft(league: League) -> None:
    st.title("Live Draft")
    refresh = st.button("Refresh draft", use_container_width=True)
    del refresh
    try:
        with st.spinner("Loading Sleeper draft…"):
            snapshot = load_draft_snapshot(league)
    except ProviderError as exc:
        st.info(str(exc))
        return
    st.caption(f"{snapshot.season} · {snapshot.rounds} rounds · {snapshot.draft_type.title()} · {snapshot.status.replace('_', ' ').title()}")
    if snapshot.current_pick is None:
        st.success(f"Draft complete · {snapshot.picks_made}/{snapshot.total_picks} picks")
    else:
        with st.container(border=True):
            status, number = st.columns([3, 1])
            status.markdown(f"**{'You are on the clock' if snapshot.on_clock_is_mine else snapshot.on_clock_team or 'On the clock'}**")
            status.caption(f"Your next pick: #{snapshot.my_next_pick}" if snapshot.my_next_pick else "No remaining picks")
            number.metric("Current", f"#{snapshot.current_pick}")
            if snapshot.picks_until_my_turn is not None:
                st.progress(max(0.0, min(1.0, 1 - snapshot.picks_until_my_turn / max(snapshot.teams, 1))), text=f"{snapshot.picks_until_my_turn} picks until your turn")

    position = st.segmented_control("Position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="draft_position")
    available = [player for player in snapshot.available if position == "ALL" or player.position == position]
    st.subheader("Best Available")
    for rank, player in enumerate(available[:30], 1):
        with st.container(border=True):
            info, value = st.columns([3, 1])
            info.markdown(f"**#{rank} · {player.name}**")
            need = " · NEED" if player.need_score > 0 else ""
            info.caption(f"{player.position} · {player.team} · Age {player.age or '—'}{need}")
            value.metric("Value", player.value)
    with st.expander(f"Recent picks · {len(snapshot.recent)}"):
        if not snapshot.recent:
            st.caption("No picks have been made.")
        for pick in snapshot.recent:
            marker = " · YOUR PICK" if pick["is_mine"] else ""
            st.write(f"**{pick['round']}.{pick['slot']:02d}** · {pick['name']} · {pick['position']} · {pick['team_name']}{marker}")
