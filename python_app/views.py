from __future__ import annotations

import csv
import html
import io

import streamlit as st

from .models import League, Roster
from .analytics import active_roster_players, build_contexts, compute_projections, depth_profile, evaluate_trade, explain_trade, optimize_lineup
from .recommendations import generate_recommendations
from .draft import load_draft_snapshot
from .providers import ProviderError
from .quality import assess_league_readiness
from .strategy import build_team_plan
from .auth import current_user_id
from .storage import StorageError, delete_decision, durable_storage_configured, load_decisions, save_decision, update_decision
from .waivers import generate_waiver_recommendations
from .counteroffers import generate_counteroffers
from .journal import trade_snapshot, waiver_snapshot
from .diagnostics import build_diagnostic_report
from .value_system import balance_label, format_value, value_profile


def _load_recommendation(idea: object) -> None:
    for key in ("trade_team_a", "trade_team_b", "trade_a_players", "trade_b_players", "trade_a_picks", "trade_b_picks"):
        st.session_state.pop(key, None)
    st.session_state.trade_prefill = idea
    st.session_state.area = "Moves"
    st.session_state.view = "Evaluate"


def _navigate(section: str, page: str) -> None:
    st.session_state.area = section
    st.session_state.view = page


def _page_header(kicker: str, title: str, description: str) -> None:
    st.markdown(
        f'<div class="page-intro"><div class="app-kicker">{html.escape(kicker)}</div>'
        f'<h1>{html.escape(title)}</h1><p>{html.escape(description)}</p></div>',
        unsafe_allow_html=True,
    )


def _section(title: str) -> None:
    st.markdown(f'<div class="section-title">{html.escape(title)}</div>', unsafe_allow_html=True)


def _stat_grid(items: list[tuple[str, object]]) -> None:
    cards = "".join(
        f'<div class="stat"><div class="stat-value">{html.escape(str(value))}</div>'
        f'<div class="stat-label">{html.escape(label)}</div></div>'
        for label, value in items
    )
    st.markdown(f'<div class="stat-grid">{cards}</div>', unsafe_allow_html=True)


def _asset_heading(name: str, meta: str) -> None:
    st.markdown(
        f'<div class="asset-card"><div class="asset-title">{html.escape(name)}</div>'
        f'<div class="asset-meta">{html.escape(meta)}</div></div>',
        unsafe_allow_html=True,
    )


def _data_list(rows: list[tuple[str, str, object, str]]) -> None:
    content = "".join(
        '<div class="data-row">'
        f'<div><div class="data-row-title">{html.escape(title)}</div>'
        f'<div class="data-row-meta">{html.escape(meta)}</div></div>'
        f'<div><div class="data-row-value">{html.escape(str(value))}</div>'
        f'<div class="data-row-label">{html.escape(label)}</div></div></div>'
        for title, meta, value, label in rows
    )
    st.markdown(f'<div class="data-list">{content}</div>', unsafe_allow_html=True)


def _compact_value(target: object, label: str, value: object) -> None:
    target.markdown(f"<div style='text-align:right;font-size:1.05rem;font-weight:800'>{value}</div><div style='text-align:right;color:#8b93a7;font-size:.68rem;text-transform:uppercase;letter-spacing:.06em'>{label}</div>", unsafe_allow_html=True)


def _team_label(roster: Roster, league: League) -> str:
    return f"{roster.team_name}{' · My team' if roster.team_id == league.my_team_id else ''}"


def home(league: League) -> None:
    _page_header("Your league", league.name, f"{league.season} · {league.mode.title()} · {league.team_count} teams")
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    context = build_contexts(league)[my_team.team_id]
    readiness = assess_league_readiness(league)
    plan = build_team_plan(league)
    lineup = optimize_lineup(active_roster_players(my_team), league)
    biggest_need = max(context.position_needs, key=context.position_needs.get)
    if readiness.level == "ready":
        st.success(readiness.title)
    elif readiness.level == "limited":
        st.warning(readiness.title + " — review the data notes before acting.")
    else:
        st.error(readiness.title + " — decision tools are restricted by missing inputs.")
    record = my_team.record if my_team.games_played else "Preseason"
    playoff = f"{context.playoff_probability}%" if context.playoff_probability is not None else "—"
    _stat_grid([("Competitive rank", f"#{context.league_rank}"), ("Record", record), ("Playoff odds", playoff), ("Resilience", f"{context.resilience_score}/100")])
    if league.values_status != "live":
        st.warning("FantasyCalc values are temporarily unavailable. Players remain visible, but value analysis is disabled rather than estimated.")
    _section("Team direction")
    st.markdown(
        f'<div class="insight"><strong>{html.escape(plan.direction)}</strong><br>{html.escape(plan.headline)}</div>',
        unsafe_allow_html=True,
    )
    _section("Priority actions")
    for number, action in enumerate(plan.actions, 1):
        st.markdown(f"**{number}.** {action}")
    if plan.protect or plan.shop:
        protect, shop = st.columns(2)
        protect.caption("PROTECT")
        protect.write(", ".join(player.name for player in plan.protect) or "No protected core identified")
        shop.caption("TEST THE MARKET")
        shop.write(", ".join(player.name for player in plan.shop) or "No urgent sell window")
    trade_col, team_col = st.columns(2)
    trade_col.button("Find a move", type="primary", use_container_width=True, on_click=_navigate, args=("Moves", "Ideas"))
    team_col.button("Review roster", use_container_width=True, on_click=_navigate, args=("Plan", "Roster"))
    settings = " · ".join(filter(None, [league.scoring.upper(), "Superflex" if league.superflex else "1QB", "TE Premium" if league.te_premium else None]))
    schedule = f" · Schedule difficulty {context.schedule_difficulty}/100" if context.schedule_difficulty is not None else ""
    deadline = f" · {context.deadline_status}" if context.deadline_status != "No deadline" else ""
    st.caption(f"{settings}  |  {context.contender_confidence} · PF rank #{context.points_rank or '—'} · Asset rank #{context.asset_rank} · Biggest need {biggest_need}{schedule}{deadline} · Best lineup {lineup.projected_points:.1f}")
    with st.expander("Data sources and limitations"):
        for source in league.source_health:
            icon = "✓" if source.level == "ready" else "!" if source.level == "limited" else "×"
            st.markdown(f"**{icon} {source.source}** — {source.detail}")
        for issue in readiness.issues:
            st.caption(issue)


def rosters(league: League) -> None:
    _page_header("Team room", "Roster", "See who starts, where your depth lives, and how every asset is valued.")
    options = {_team_label(roster, league): roster for roster in league.rosters}
    scope = st.segmented_control("Roster scope", ["My team", "League team"], default="My team", label_visibility="collapsed")
    if scope == "My team":
        selected = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    else:
        other_options = {label: roster for label, roster in options.items() if roster.team_id != league.my_team_id}
        selected = other_options[st.selectbox("Choose a team", other_options)]
    active_players = active_roster_players(selected)
    resilience = depth_profile(active_players, league)
    _stat_grid([
        ("Players", len(selected.players)),
        ("Future picks", len(selected.draft_picks)),
        ("Total assets", format_value(selected.total_asset_value)),
        ("Resilience", f"{resilience.score}/100"),
    ])
    if resilience.warnings:
        st.warning(f"{resilience.label} depth · " + " · ".join(resilience.warnings))
    with st.expander("Resilience by position"):
        for position_name, score in resilience.position_scores:
            status = "Critical" if position_name in resilience.critical_positions else "Covered"
            st.write(f"**{position_name}** · {score}/100 · {status}")
        st.caption(f"{resilience.playable_backups} playable backups · {resilience.injury_exposure} injured or questionable starters")
    lineup = optimize_lineup(active_players, league)
    with st.expander(f"Best lineup · {lineup.projected_points:.1f} estimated PPG"):
        for player in lineup.starters:
            st.write(f"**{player.position}** · {player.name} · {player.team}")
    _section("Player inventory")
    position = st.pills("Filter by position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL")
    players = [player for player in selected.players if position == "ALL" or player.position == position]
    _data_list([
        (
            player.name,
            f"{player.position} · {player.team} · Age {player.age or '—'}{f' · {player.injury_status.upper()}' if player.injury_status else ''} · {value_profile(player, league).tier}",
            format_value(player.value) if league.values_status == "live" else "—",
            "Market",
        )
        for player in sorted(players, key=lambda item: item.value, reverse=True)
    ])
    if selected.draft_picks:
        with st.expander(f"Draft capital · {len(selected.draft_picks)} picks"):
            for pick in selected.draft_picks:
                owner_note = "" if pick.original_owner == selected.team_id else f" · via Team {pick.original_owner}"
                st.write(f"**{pick.label}**{owner_note} · Market {format_value(pick.value)}")


def rankings(league: League) -> None:
    _page_header("League landscape", "Competitive Outlook", "Season results and scoring set the race; roster strength, depth, age, and picks shape what comes next.")
    contexts = build_contexts(league)
    view = st.segmented_control("Ranking lens", ["Competitive", "Assets"], default="Competitive", label_visibility="collapsed")
    rank_field = "league_rank" if view == "Competitive" else "asset_rank"
    ranked = sorted(league.rosters, key=lambda roster: getattr(contexts[roster.team_id], rank_field))
    _section("League order")
    _data_list([
        (
            f"#{getattr(contexts[roster.team_id], rank_field)} · {_team_label(roster, league)}",
            f"{roster.owner_name} · {roster.record if roster.games_played else 'Preseason'} · PF #{contexts[roster.team_id].points_rank or '—'} · {contexts[roster.team_id].contender_confidence} · {str(contexts[roster.team_id].playoff_probability) + '% playoffs' if contexts[roster.team_id].playoff_probability is not None else 'No playoff model'} · {'Asset #' + str(contexts[roster.team_id].asset_rank) if view == 'Competitive' else 'Competitive #' + str(contexts[roster.team_id].league_rank)}",
            contexts[roster.team_id].power_score if view == "Competitive" else (contexts[roster.team_id].asset_score if league.values_status == "live" else "—"),
            "Outlook" if view == "Competitive" else "Asset score",
        )
        for rank, roster in enumerate(ranked, 1)
    ])


def values(league: League) -> None:
    _page_header("Market", "Player Values", "Use market price as a negotiating baseline, then weigh range, tier, production, and your team context.")
    query = st.text_input("Search players", placeholder="Search name or NFL team")
    position = st.pills("Position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="values_position")
    unique_players = {player.id: player for roster in league.rosters for player in roster.players}.values()
    all_players = list(unique_players)
    position_ranks = {
        player.id: rank
        for player_position in ("QB", "RB", "WR", "TE", "K", "DEF")
        for rank, player in enumerate(
            sorted((item for item in all_players if item.position == player_position), key=lambda item: item.value, reverse=True),
            1,
        )
    }
    filtered = [
        player for player in all_players
        if (position == "ALL" or player.position == position)
        and (not query or query.lower() in player.name.lower() or query.lower() in player.team.lower())
    ]
    market_source = next((source for source in league.source_health if source.source == "FantasyCalc"), None)
    freshness = f" · refreshed {market_source.observed_at}" if market_source and market_source.observed_at else ""
    st.caption(f"{len(filtered)} rostered players · FantasyCalc format-adjusted market{freshness}")
    st.caption("Asset tiers are relative to this league's rostered market—not projected lineup roles. Negotiation bands are heuristic ranges for trade discussion, not statistical confidence intervals.")
    _section("Market board")
    _data_list([
        (
            f"#{rank} · {player.name}",
            f"{player.position}{position_ranks.get(player.id, '—')} · {player.team} · Age {player.age or '—'} · {value_profile(player, league).tier} · negotiation band {format_value(value_profile(player, league).low)}–{format_value(value_profile(player, league).high)}",
            format_value(player.value) if league.values_status == "live" else "—",
            "Market",
        )
        for rank, player in enumerate(sorted(filtered, key=lambda item: item.value, reverse=True), 1)
    ])


def projections(league: League) -> None:
    _page_header("Research", "Market Signals", f"Week {league.current_week} · league-relative production and role compared with market rank")
    position = st.pills("Position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="edge_position")
    recommendation = st.pills("Signal", ["ALL", "MODEL WELL ABOVE MARKET", "MODEL ABOVE MARKET", "MARKET ALIGNED", "MARKET ABOVE MODEL", "MARKET WELL ABOVE MODEL", "LOW CONFIDENCE"], default="ALL")
    results = [item for item in compute_projections(league) if (position == "ALL" or item.player.position == position) and (recommendation == "ALL" or item.recommendation == recommendation)]
    if not league.player_stats:
        st.warning("Season production is unavailable; results currently use neutral production and role scores.")
    st.caption("Signals describe disagreement between current production/role evidence and market rank. They are not buy or sell instructions.")
    st.caption(f"{len(results)} players match these signals")
    _section("Opportunity board")
    for item in results:
        with st.container(border=True):
            heading, signal = st.columns([3, 1])
            with heading:
                _asset_heading(item.player.name, f"{item.player.position} · {item.player.team} · Age {item.player.age or '—'}")
            signal.markdown(f'<div style="text-align:right"><span class="signal">{html.escape(item.recommendation)}</span></div>', unsafe_allow_html=True)
            _stat_grid([("Model pct", item.edge_score), ("Market pct", item.market_score), ("FPPG", f"{item.fppg:.1f}" if item.fppg is not None else "—")])
            if item.signals:
                with st.expander("Why"):
                    for signal_text in item.signals:
                        st.write(f"• {signal_text}")


def diagnostics(league: League) -> None:
    _page_header("System health", "Data Diagnostics", "See exactly which evidence is available, stale, incomplete, or limiting recommendation confidence.")
    report = build_diagnostic_report(league)
    if report.level == "Healthy":
        st.success(f"{report.level} · {report.score}/100")
    elif report.level == "Usable with limits":
        st.warning(f"{report.level} · {report.score}/100")
    else:
        st.error(f"{report.level} · {report.score}/100")
    _section("Coverage")
    for index in range(0, len(report.metrics), 3):
        _stat_grid(report.metrics[index:index + 3])
    _section("Provider status")
    for source in league.source_health:
        icon = "✓" if source.level == "ready" else "!" if source.level == "limited" else "×"
        st.markdown(f"**{icon} {source.source}** — {source.detail}")
    if report.issues:
        _section("Limits to account for")
        for issue in report.issues:
            st.write(f"• {issue}")
    if report.strengths:
        with st.expander("Healthy checks"):
            for strength in report.strengths:
                st.write(f"✓ {strength}")
    st.caption("Refresh the league from the top navigation after injuries, waivers, trades, or scoring corrections.")


def recommendations(league: League) -> None:
    _page_header("Actionable deals", "Trade Finder", "Real partners and owned assets, filtered for fairness, fit, and lineup impact.")
    position = st.pills("Target position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="recommendation_position")
    show_experimental = st.toggle(
        "Show D-grade experiments",
        value=False,
        help="D-grade packages are missing too much evidence to be normal review candidates.",
    )
    if league.trade_deadline_week is not None and league.current_week > league.trade_deadline_week and any(roster.games_played for roster in league.rosters):
        st.info(f"Your week {league.trade_deadline_week} trade deadline has passed. Trade Finder is paused so it does not present unavailable moves.")
        return
    all_ideas = generate_recommendations(
        league,
        target_position=None if position == "ALL" else position,
        include_low_confidence=True,
        include_review_candidates=True,
    )
    ideas = [idea for idea in all_ideas if idea.confidence != "D" or show_experimental]
    if not ideas:
        st.info("No package is currently strong enough to recommend or review. Try another position or refresh league data after projections, injuries, or roster activity change.")
        return
    qualified_ideas = [idea for idea in ideas if not idea.review_only and idea.confidence in {"A", "B"} and idea.score >= 65]
    actionable_ideas = qualified_ideas[:5]
    alternative_ideas = qualified_ideas[5:8]
    review_ideas = [idea for idea in ideas if idea not in qualified_ideas and idea.confidence != "D"][:3]
    experimental_ideas = [idea for idea in ideas if idea.confidence == "D"][:2]
    ideas = actionable_ideas + alternative_ideas + review_ideas + experimental_ideas
    actionable = len(actionable_ideas)
    alternatives = len(alternative_ideas)
    review = len(review_ideas)
    experimental = sum(idea.confidence == "D" for idea in ideas)
    if actionable:
        summary = f"{actionable} shortlisted"
        if alternatives:
            summary += f" · {alternatives} actionable alternative{'s' if alternatives != 1 else ''}"
        if review:
            summary += f" · {review} needs review"
        if experimental:
            summary += f" · {experimental} experimental"
        st.caption(summary)
    else:
        st.warning(f"No actionable deal clears every gate. Showing {review} review candidate{'s' if review != 1 else ''} without presenting them as recommendations.")
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    my_context = build_contexts(league)[my_team.team_id]
    depth_pick_labels = [pick.label for idea in ideas if idea.kind == "DEPTH" for pick in idea.send_picks]
    shared_picks = sorted({label for label in depth_pick_labels if depth_pick_labels.count(label) > 1})
    if shared_picks:
        st.info(f"Alternative packages: {', '.join(shared_picks)} appears in multiple ideas. Choose one use of that pick, then refresh the plan after any completed move.")
    _section("Best available deals" if actionable else "Candidates worth reviewing")
    for idea in ideas:
        with st.container(border=True):
            heading, score = st.columns([3, 1])
            with heading:
                tier = idea.kind if idea in actionable_ideas else f"ALTERNATIVE · {idea.kind}" if idea in alternative_ideas else f"REVIEW · {idea.kind}"
                _asset_heading(f"{tier} · {idea.partner.team_name}", idea.reason)
            _compact_value(score, f"Evidence {idea.confidence}", f"{idea.score}/100")
            sends = [player.name for player in idea.send_players] + [pick.label for pick in idea.send_picks]
            receives = [player.name for player in idea.receive_players] + [pick.label for pick in idea.receive_picks]
            st.write(f"**Send:** {', '.join(sends) or 'Nothing'}")
            st.write(f"**Receive:** {', '.join(receives) or 'Nothing'}")
            playoff_gain = idea.evaluation.lineup_a.playoff_points_gained
            fairness = idea.evaluation.fairness
            market_balance = balance_label(fairness)
            _stat_grid([("Market balance", market_balance), ("Your lineup", f"{idea.evaluation.lineup_a.points_gained:+.1f}"), ("Resilience", f"{idea.evaluation.lineup_a.before_resilience} → {idea.evaluation.lineup_a.after_resilience}"), ("Playoff lineup", f"{playoff_gain:+.1f}" if playoff_gain is not None else "Unavailable")])
            with st.expander("Before and after roster impact"):
                impact = idea.evaluation.lineup_a
                st.write(f"**New starters:** {', '.join(impact.new_starters) or 'No change'}")
                st.write(f"**Outgoing starters:** {', '.join(impact.outgoing_starters) or 'None'}")
                st.write(f"**Internal replacements:** {', '.join(impact.internal_replacements) or 'None needed'}")
                st.write(f"**Displaced to bench:** {', '.join(impact.displaced_starters) or 'None'}")
                st.write(f"**Depth change:** {impact.depth_change:+.1f}")
                if impact.coverage_warnings:
                    st.warning("Coverage after trade: " + "; ".join(impact.coverage_warnings))
            with st.expander("Evidence and cautions"):
                st.markdown(f"**Evidence grade {idea.confidence}**")
                for item in idea.confidence_reasons:
                    st.write(f"• {item}")
                st.markdown("**Score breakdown**")
                for label, contribution in idea.score_breakdown:
                    st.write(f"{label}: {contribution:+.1f}")
                st.markdown("**Evidence**")
                for item in idea.evidence:
                    st.write(f"✓ {item}")
                for item in idea.cautions:
                    st.write(f"! {item}")
                if not idea.cautions:
                    st.caption("No additional quality-gate cautions were triggered.")
            st.button("Open in Trade Simulator", key=f"open-{idea.partner.team_id}-{sends}-{receives}", use_container_width=True, on_click=_load_recommendation, args=(idea,))
            if st.button("Save to journal", key=f"save-idea-{idea.partner.team_id}-{sends}-{receives}", use_container_width=True):
                decision = trade_snapshot(
                    league, my_team, idea.partner, idea.send_players, idea.receive_players,
                    idea.send_picks, idea.receive_picks, idea.evaluation, my_context,
                    source="trade_finder", confidence=idea.confidence, score=idea.score,
                    score_breakdown=idea.score_breakdown,
                )
                try:
                    save_decision(current_user_id(), decision)
                    st.success("Recommendation saved with its model snapshot.")
                except StorageError as exc:
                    st.error(str(exc))


def waivers(league: League) -> None:
    _page_header("Weekly moves", "Waiver Assistant", "Exact add/drop recommendations measured against your lineup, playoff weeks, depth, and dynasty timeline.")
    position = st.pills("Position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="waiver_position")
    ideas = generate_waiver_recommendations(league)
    if position != "ALL":
        ideas = [idea for idea in ideas if idea.add.position == position]
    if not league.free_agents:
        st.info("The unrostered player pool is unavailable. Refresh or reconnect the league when market values are available.")
        return
    if not ideas:
        st.info("No available player currently clears the add/drop quality gates for this roster.")
        return
    st.caption(f"{len(ideas)} claims clear the roster-impact gates")
    shared_drops: dict[str, int] = {}
    for idea in ideas:
        if idea.drop:
            shared_drops[idea.drop.id] = shared_drops.get(idea.drop.id, 0) + 1
    repeated = [idea.drop.name for idea in ideas if idea.drop and shared_drops[idea.drop.id] > 1]
    if repeated:
        st.info(f"Submit these as a priority queue, not independent moves. Multiple claims use {repeated[0]} as the drop; only the highest successful claim can use that roster spot.")
    _section("Claim priority")
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    for claim_rank, idea in enumerate(ideas, 1):
        with st.container(border=True):
            heading, score = st.columns([3, 1])
            with heading:
                drop = f"Drop {idea.drop.name}" if idea.drop else "Use open roster spot"
                _asset_heading(f"#{claim_rank} · {idea.category} · Add {idea.add.name}", f"{idea.add.position} · {idea.add.team} · {drop}")
            _compact_value(score, f"Data confidence {idea.confidence}", f"{idea.score}/100")
            st.write(idea.reason)
            st.caption(idea.lineup_change)
            st.caption(idea.claim_guidance)
            _stat_grid([
                ("Weekly lineup", f"{idea.lineup_gain:+.1f}"),
                ("Playoff lineup", f"{idea.playoff_gain:+.1f}" if idea.playoff_gain is not None else "—"),
                ("Asset outlook", idea.value_band),
            ])
            if idea.cautions or idea.confidence_reasons:
                with st.expander("Evidence and cautions"):
                    for evidence in idea.confidence_reasons:
                        st.write(f"✓ {evidence}")
                    for caution in idea.cautions:
                        st.write(f"• {caution}")
            if st.button("Save to journal", key=f"save-waiver-{idea.add.id}-{idea.drop.id if idea.drop else 'open'}", use_container_width=True):
                try:
                    save_decision(current_user_id(), waiver_snapshot(league, my_team, idea))
                    st.success("Waiver recommendation saved with its model snapshot.")
                except StorageError as exc:
                    st.error(str(exc))


def trade(league: League) -> None:
    _page_header("Deal room", "Trade Simulator", "Build a package, then see market fairness, team fit, and starting-lineup impact.")
    if league.values_status != "live":
        st.warning("Trade analysis requires current market values. Refresh the league when FantasyCalc is available.")
        return
    labels = {_team_label(roster, league): roster for roster in league.rosters}
    prefill = st.session_state.get("trade_prefill")
    team_a = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    opponents = {label: roster for label, roster in labels.items() if roster.team_id != team_a.team_id}
    partner_index = 0
    if prefill:
        partner_index = next((index for index, roster in enumerate(opponents.values()) if roster.team_id == prefill.partner.team_id), 0)
    _section("Choose a trade partner")
    team_b_label = st.selectbox("Manager", opponents, index=partner_index, key="trade_team_b", placeholder="Choose a manager")
    team_b = opponents[team_b_label]
    _section("Build the package")
    a_options = {f"{player.name} · {player.position} · {format_value(player.value)}": player for player in sorted(team_a.players, key=lambda item: item.value, reverse=True)}
    b_options = {f"{player.name} · {player.position} · {format_value(player.value)}": player for player in sorted(team_b.players, key=lambda item: item.value, reverse=True)}
    prefill_a_ids = {player.id for player in prefill.send_players} if prefill and team_b.team_id == prefill.partner.team_id else set()
    prefill_b_ids = {player.id for player in prefill.receive_players} if prefill and team_b.team_id == prefill.partner.team_id else set()
    a_defaults = [label for label, player in a_options.items() if player.id in prefill_a_ids]
    b_defaults = [label for label, player in b_options.items() if player.id in prefill_b_ids]
    st.markdown("**You send**")
    st.markdown('<div class="field-help">Select one or more players from your roster.</div>', unsafe_allow_html=True)
    a_selected = st.multiselect("Players you send", a_options, default=a_defaults, key="trade_a_players", label_visibility="collapsed", placeholder="Add your players")
    st.markdown("**You receive**")
    st.markdown(f'<div class="field-help">Select players from {html.escape(team_b.team_name)}.</div>', unsafe_allow_html=True)
    b_selected = st.multiselect("Players you receive", b_options, default=b_defaults, key="trade_b_players", label_visibility="collapsed", placeholder="Add their players")
    a_pick_options = {f"{pick.label} · via Team {pick.original_owner} · {format_value(pick.value)}": pick for pick in team_a.draft_picks}
    b_pick_options = {f"{pick.label} · via Team {pick.original_owner} · {format_value(pick.value)}": pick for pick in team_b.draft_picks}
    if league.mode != "redraft":
        prefill_a_picks = {(pick.year, pick.round, pick.original_owner) for pick in prefill.send_picks} if prefill else set()
        prefill_b_picks = {(pick.year, pick.round, pick.original_owner) for pick in prefill.receive_picks} if prefill else set()
        a_pick_defaults = [label for label, pick in a_pick_options.items() if (pick.year, pick.round, pick.original_owner) in prefill_a_picks]
        b_pick_defaults = [label for label, pick in b_pick_options.items() if (pick.year, pick.round, pick.original_owner) in prefill_b_picks]
        with st.expander("Add draft picks"):
            a_picks = st.multiselect("Picks you send", a_pick_options, default=a_pick_defaults, key="trade_a_picks", placeholder="Add your picks")
            b_picks = st.multiselect("Picks you receive", b_pick_options, default=b_pick_defaults, key="trade_b_picks", placeholder="Add their picks")
    else:
        a_picks, b_picks = [], []
    if not (a_selected or b_selected or a_picks or b_picks):
        st.info("Select players or picks to evaluate a trade.")
        return
    selected_a_players = [a_options[key] for key in a_selected]
    selected_b_players = [b_options[key] for key in b_selected]
    selected_a_picks = [a_pick_options[key] for key in a_picks]
    selected_b_picks = [b_pick_options[key] for key in b_picks]
    trade_contexts = build_contexts(league)
    result = evaluate_trade(
        team_a, team_b,
        selected_a_players, selected_b_players, league,
        selected_a_picks, selected_b_picks,
        trade_contexts,
    )
    context_a, context_b = trade_contexts[team_a.team_id], trade_contexts[team_b.team_id]
    narrative = explain_trade(team_a, selected_a_players, selected_b_players, result, context_a)
    _section("Deal verdict")
    st.subheader(result.verdict)
    st.markdown(
        f'<div class="insight"><strong>{html.escape(narrative.label)}</strong><br>{html.escape(narrative.summary)}</div>',
        unsafe_allow_html=True,
    )
    for reason in narrative.reasons:
        st.write(f"• {reason}")
    st.warning(f"Primary risk: {narrative.primary_risk}")
    _stat_grid([("You send", f"{result.team_a_gives:.1f}"), ("You receive", f"{result.team_b_gives:.1f}"), ("Value edge", f"{result.difference_for_a:+.1f}")])
    _stat_grid([(f"{context_a.window} fit", f"{result.fit_a:+.1f}"), (f"{context_b.window} fit", f"{result.fit_b:+.1f}"), ("Market balance", balance_label(result.fairness))])
    st.caption(f"Raw market difference: {result.fairness:+.1f}%. Treat small differences as noise inside the value range, not a precise edge.")
    st.progress(result.acceptance_score / 100, text=f"Partner-fit score for {team_b.team_name}: {result.acceptance_score}/100")
    tendency = league.manager_tendencies.get(team_b.team_id, {})
    history = f" This manager has completed {int(tendency.get('trades', 0))} trades this season." if tendency else ""
    st.caption("Partner fit blends market value, roster direction, lineup impact, and observed league trade behavior. It is a decision aid, not an acceptance probability." + history)
    _section("Lineup impact")
    left, right = st.columns(2)
    left.metric(team_a.team_name, f"{result.lineup_a.points_gained:+.1f} PPG", result.lineup_a.recommendation)
    right.metric(team_b.team_name, f"{result.lineup_b.points_gained:+.1f} PPG", result.lineup_b.recommendation)
    if b_selected and not result.lineup_a.received_player_starts:
        st.warning("The primary return does not currently crack your optimized starting lineup.")
    _stat_grid([("Your resilience", f"{result.lineup_a.before_resilience} → {result.lineup_a.after_resilience}"), ("Their resilience", f"{result.lineup_b.before_resilience} → {result.lineup_b.after_resilience}"), ("Your coverage", "Clear" if not result.lineup_a.coverage_warnings else f"{len(result.lineup_a.coverage_warnings)} risks")])
    if result.lineup_a.playoff_points_gained is not None:
        st.caption(f"Playoff weeks {', '.join(map(str, result.lineup_a.playoff_weeks_modeled))}: {result.lineup_a.playoff_points_gained:+.1f} projected PPG for your optimized lineup.")
    with st.expander("Before and after roster impact"):
        st.write(f"**New starters:** {', '.join(result.lineup_a.new_starters) or 'No change'}")
        st.write(f"**Outgoing starters:** {', '.join(result.lineup_a.outgoing_starters) or 'None'}")
        st.write(f"**Internal replacements:** {', '.join(result.lineup_a.internal_replacements) or 'None needed'}")
        st.write(f"**Displaced to bench:** {', '.join(result.lineup_a.displaced_starters) or 'None'}")
        if result.lineup_a.coverage_warnings:
            st.warning("Coverage after trade: " + "; ".join(result.lineup_a.coverage_warnings))
    _section("Negotiation options")
    if st.button("Build counteroffers", use_container_width=True):
        counters = generate_counteroffers(
            team_a, team_b, selected_a_players, selected_b_players, league,
            selected_a_picks, selected_b_picks, trade_contexts,
        )
        if not counters:
            st.info("No one-step adjustment clears the fairness and roster-impact gates. Rebuild the package around a different primary asset.")
        for counter in counters:
            with st.container(border=True):
                st.markdown(f"**{counter.label} · {counter.edits} package edit{'s' if counter.edits != 1 else ''}**")
                st.caption(counter.description)
                sends = [player.name for player in counter.team_a_players] + [pick.label for pick in counter.team_a_picks]
                receives = [player.name for player in counter.team_b_players] + [pick.label for pick in counter.team_b_picks]
                st.write(f"**Send:** {', '.join(sends)}")
                st.write(f"**Receive:** {', '.join(receives)}")
                _stat_grid([
                    ("Market", balance_label(counter.evaluation.fairness)),
                    ("Your lineup", f"{counter.evaluation.lineup_a.points_gained:+.1f}"),
                    ("Partner fit", f"{counter.evaluation.acceptance_score}/100"),
                ])
    if st.button("Save to journal", type="primary", use_container_width=True):
        decision = trade_snapshot(
            league, team_a, team_b, selected_a_players, selected_b_players,
            selected_a_picks, selected_b_picks, result, context_a, source="manual_evaluation",
        )
        try:
            save_decision(current_user_id(), decision)
            st.success("Decision and model inputs saved permanently." if durable_storage_configured() else "Decision and model inputs saved for this session.")
        except StorageError as exc:
            st.error(str(exc))


def history(league: League) -> None:
    _page_header("Decision history", "Journal & Calibration", "Track what the model advised, what you did, and whether the prediction held up.")
    try:
        saved = load_decisions(current_user_id(), league.id)
    except StorageError as exc:
        st.error(str(exc))
        return
    if not saved:
        st.info("No decisions saved for this league yet. Save a trade or waiver recommendation to begin calibration.")
        return
    resolved_trades = [item for item in saved if item.get("decision_type") == "trade" and item.get("status") in {"accepted", "rejected", "completed"}]
    accepted = sum(item.get("status") in {"accepted", "completed"} for item in resolved_trades)
    completed = [item for item in saved if item.get("outcome", {}).get("actual_lineup_change") is not None]
    errors = [abs(float(item["outcome"]["actual_lineup_change"]) - float(item.get("payload", {}).get("prediction", {}).get("lineup_change") or 0)) for item in completed]
    avg_error = sum(errors) / len(errors) if errors else None
    _stat_grid([
        ("Tracked", len(saved)),
        ("Trade acceptance", f"{accepted / len(resolved_trades):.0%}" if resolved_trades else "—"),
        ("Avg PPG error", f"{avg_error:.1f}" if avg_error is not None else "—"),
    ])
    confidence_counts: dict[str, int] = {}
    for item in saved:
        confidence = str(item.get("payload", {}).get("confidence") or "Unrated")
        confidence_counts[confidence] = confidence_counts.get(confidence, 0) + 1
    st.caption("Confidence mix: " + " · ".join(f"{grade} {count}" for grade, count in sorted(confidence_counts.items())))
    output = io.StringIO()
    export_rows = [{
        "id": item.get("id"), "saved_at": item.get("saved_at"), "type": item.get("decision_type"),
        "title": item.get("title"), "status": item.get("status"), "feedback": item.get("feedback"),
        "confidence": item.get("payload", {}).get("confidence"),
        "predicted_lineup_change": item.get("payload", {}).get("prediction", {}).get("lineup_change"),
        "actual_lineup_change": item.get("outcome", {}).get("actual_lineup_change"),
        "model_version": item.get("payload", {}).get("model_version"),
    } for item in saved]
    writer = csv.DictWriter(output, fieldnames=list(export_rows[0].keys()))
    writer.writeheader()
    writer.writerows(export_rows)
    st.download_button("Export calibration CSV", output.getvalue(), file_name=f"{league.name}-decision-journal.csv", mime="text/csv", use_container_width=True)
    _section("Decision entries")
    for index, item in enumerate(saved):
        payload = item.get("payload") or {}
        prediction = payload.get("prediction") or {}
        outcome = item.get("outcome") or {}
        with st.container(border=True):
            st.markdown(f"**{item.get('title', 'Decision')}**")
            st.caption(f"{item.get('decision_type', 'decision').title()} · {item.get('status', 'considering').replace('_', ' ').title()} · {payload.get('model_version', 'legacy model')}")
            if item.get("decision_type") == "trade":
                st.write(f"**Send:** {payload.get('sends_label', '—')}")
                st.write(f"**Receive:** {payload.get('receives_label', '—')}")
                _stat_grid([("Market", f"{float(prediction.get('fairness') or 0):+.1f}%"), ("Predicted PPG", f"{float(prediction.get('lineup_change') or 0):+.1f}"), ("Partner fit", f"{prediction.get('partner_fit', '—')}/100")])
                statuses = ["considering", "offered", "accepted", "rejected", "completed"]
            else:
                add = payload.get("add") or {}
                drop = payload.get("drop") or {}
                st.write(f"**Add:** {add.get('name', '—')} · **Drop:** {drop.get('name', 'Open spot')}")
                _stat_grid([("Predicted PPG", f"{float(prediction.get('lineup_change') or 0):+.1f}"), ("Value", f"{float(prediction.get('value_change') or 0):+.0f}"), ("Suggested FAAB", payload.get("suggested_faab", "—"))])
                statuses = ["considering", "submitted", "succeeded", "failed", "completed"]
            with st.form(f"outcome-{item['id']}"):
                current_status = item.get("status") if item.get("status") in statuses else statuses[0]
                status = st.selectbox("Outcome status", statuses, index=statuses.index(current_status))
                feedback_options = ["", "Useful", "Unrealistic", "Too expensive", "Wrong team direction", "Partner would not accept"]
                current_feedback = item.get("feedback") or ""
                feedback = st.selectbox("Model feedback", feedback_options, index=feedback_options.index(current_feedback) if current_feedback in feedback_options else 0)
                actual_lineup = st.number_input("Observed lineup change (PPG)", value=float(outcome.get("actual_lineup_change") or 0), step=0.1)
                actual_value = st.number_input("Observed market-value change", value=float(outcome.get("actual_value_change") or 0), step=1.0)
                notes = st.text_input("Outcome notes", value=str(outcome.get("notes") or ""))
                if st.form_submit_button("Update outcome", use_container_width=True):
                    try:
                        update_decision(current_user_id(), str(item["id"]), {"status": status, "feedback": feedback or None, "outcome": {"actual_lineup_change": actual_lineup, "actual_value_change": actual_value, "notes": notes}})
                        st.rerun()
                    except StorageError as exc:
                        st.error(str(exc))
            if st.button("Remove", key=f"remove-decision-{item['saved_at']}-{index}"):
                try:
                    delete_decision(current_user_id(), str(item["id"]))
                    st.rerun()
                except StorageError as exc:
                    st.error(str(exc))


@st.fragment(run_every=15)
def draft(league: League) -> None:
    _page_header("Draft room", "Live Draft", "Best available players, roster needs, and your position in the Sleeper draft.")
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

    position = st.pills("Position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="draft_position")
    available = [player for player in snapshot.available if position == "ALL" or player.position == position]
    _section("Best available")
    _data_list([
        (f"#{rank} · {player.name}", f"{player.position} · {player.team} · Age {player.age or '—'}{' · NEED' if player.need_score > 0 else ''}", player.value, "Value")
        for rank, player in enumerate(available[:30], 1)
    ])
    with st.expander(f"Recent picks · {len(snapshot.recent)}"):
        if not snapshot.recent:
            st.caption("No picks have been made.")
        for pick in snapshot.recent:
            marker = " · YOUR PICK" if pick["is_mine"] else ""
            st.write(f"**{pick['round']}.{pick['slot']:02d}** · {pick['name']} · {pick['position']} · {pick['team_name']}{marker}")
