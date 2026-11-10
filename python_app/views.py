from __future__ import annotations

import csv
from dataclasses import replace
import html
import io

import streamlit as st

from .models import League, Roster
from .analytics import active_roster_players, backtest_projection_model, backtest_recommendation_model, build_contexts, compute_projection_profiles, compute_projections, depth_profile, evaluate_trade, explain_trade, optimize_lineup
from .recommendations import generate_multi_step_paths, generate_sell_offers, generate_target_offers, recommendation_search_notes, timed_generate_recommendations
from .draft import load_draft_snapshot
from .providers import ProviderError
from .quality import assess_league_readiness
from .strategy import build_team_plan
from .auth import current_user_id
from .storage import StorageError, delete_decision, durable_storage_configured, load_decisions, save_decision, update_decision
from .waivers import generate_waiver_recommendations
from .counteroffers import generate_counteroffers
from .journal import build_calibration_report, journal_partner_tendencies, trade_snapshot, waiver_snapshot
from .diagnostics import build_diagnostic_report
from .value_system import balance_label, format_value, pick_profile, value_profile


def _load_recommendation(idea: object) -> None:
    for key in ("trade_team_a", "trade_team_b", "trade_a_players", "trade_b_players", "trade_a_picks", "trade_b_picks", "trade_counter_signature", "trade_counteroffers"):
        st.session_state.pop(key, None)
    st.session_state.trade_prefill = idea
    st.session_state.area = "Moves"
    st.session_state.view = "Evaluate"


def _navigate(section: str, page: str) -> None:
    st.session_state.area = section
    st.session_state.view = page


def _navigate_filtered(section: str, page: str, filter_key: str, filter_value: str) -> None:
    st.session_state[filter_key] = filter_value
    _navigate(section, page)


TRADE_FINDER_CACHE_VERSION = 24


def _calibrated_trade_league(league: League) -> League:
    try:
        learned = journal_partner_tendencies(load_decisions(current_user_id(), league.id))
    except StorageError:
        return league
    if not learned:
        return league
    tendencies = {team_id: dict(values) for team_id, values in league.manager_tendencies.items()}
    for team_id, values in learned.items():
        tendencies.setdefault(team_id, {}).update(values)
    signature = ",".join(
        f"{team_id}:{int(values.get('journal_resolved', 0))}:{int(values.get('journal_accepted', 0))}:"
        f"{int(values.get('journal_partner_reject_feedback', 0))}"
        for team_id, values in sorted(learned.items())
    )
    return replace(league, manager_tendencies=tendencies, imported_at=f"{league.imported_at or ''}|journal:{signature}")


def _cached_trade_finder(league: League, target_position: str | None, risk_profile: str, engine_version: int) -> tuple[list[object], object]:
    """Cache recommendation objects in-session without pickling live dataclasses."""
    cache_key = (engine_version, league.id, league.imported_at, target_position, risk_profile)
    cached = st.session_state.get("_trade_finder_cache")
    if cached and cached.get("key") == cache_key:
        return cached["value"]
    value = timed_generate_recommendations(
        league,
        target_position=target_position,
        include_low_confidence=True,
        include_review_candidates=True,
        risk_profile=risk_profile,
    )
    st.session_state._trade_finder_cache = {"key": cache_key, "value": value}
    return value


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
    _section("Next best action")
    next_position = context.critical_positions[0] if context.critical_positions else biggest_need
    needs_insurance = context.resilience_score < 60 or bool(context.critical_positions)
    next_action = plan.actions[0]
    st.markdown(f'<div class="insight"><strong>{html.escape(next_action)}</strong><br>{"Open the waiver pool for an immediate depth fix." if needs_insurance else "Open a pre-filtered trade search for realistic upgrades."}</div>', unsafe_allow_html=True)
    if needs_insurance:
        st.button(
            f"Find {next_position} waiver help", type="primary", use_container_width=True,
            on_click=_navigate_filtered, args=("Moves", "Waivers", "waiver_position", next_position),
        )
    else:
        st.button(
            f"Find a {next_position} upgrade", type="primary", use_container_width=True,
            on_click=_navigate_filtered, args=("Moves", "Ideas", "recommendation_position", next_position),
        )
    with st.expander("Full action plan"):
        for number, action in enumerate(plan.actions, 1):
            st.markdown(f"**{number}.** {action}")
    if plan.protect or plan.shop:
        protect, shop = st.columns(2)
        protect.caption("PROTECT")
        protect.write(", ".join(player.name for player in plan.protect) or "No protected core identified")
        shop.caption("TEST THE MARKET")
        shop.write(", ".join(player.name for player in plan.shop) or "No urgent sell window")
    st.button("Review roster", use_container_width=True, on_click=_navigate, args=("Plan", "Roster"))
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
        ("Total assets", format_value(selected.player_value + sum(pick_profile(pick, league).adjusted_value for pick in selected.draft_picks))),
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
                profile = pick_profile(pick, league)
                leader = f" · led by {profile.top_prospects[0]}" if profile.top_prospects else ""
                st.write(f"**{pick.label} · {profile.projection}**{owner_note} · {format_value(profile.adjusted_value)} · {profile.class_outlook}{leader} · range {format_value(profile.low)}–{format_value(profile.high)} · {profile.confidence.lower()} pick confidence")


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
    st.caption(f"{len(filtered)} rostered players · 60% FantasyCalc league-adjusted market + 40% Stats Guy Fantasy consensus{freshness}")
    st.caption("Secondary market and TE-premium data from [Stats Guy Fantasy](https://statsguyfantasy.com/).")
    st.caption("Asset tiers are relative to this league's rostered market—not projected lineup roles. Negotiation bands are heuristic ranges for trade discussion, not statistical confidence intervals.")
    _section("Market board")
    _data_list([
        (
            f"#{rank} · {player.name}",
            f"{player.position}{position_ranks.get(player.id, '—')} · {player.team} · Age {player.age or '—'} · {value_profile(player, league).tier} · negotiation band {format_value(value_profile(player, league).low)}–{format_value(value_profile(player, league).high)}{f' · source disagreement {value_profile(player, league).source_disagreement:.0f}%' if value_profile(player, league).source_count > 1 else ' · single source'}",
            format_value(player.value) if league.values_status == "live" else "—",
            "Market",
        )
        for rank, player in enumerate(sorted(filtered, key=lambda item: item.value, reverse=True), 1)
    ])


def projections(league: League) -> None:
    _page_header("Research", "Player Outlook", f"Week {league.current_week} · expected scoring range, recent role, and market disagreement")
    lens = st.segmented_control("Research lens", ["Weekly outlook", "Market signals"], default="Weekly outlook", label_visibility="collapsed")
    query = st.text_input("Search players", placeholder="Search player or NFL team", key="outlook_search")
    position = st.pills("Position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="edge_position")
    if lens == "Weekly outlook":
        sort_by = st.selectbox("Sort by", ["Expected points", "Ceiling", "Recent scoring"], label_visibility="collapsed")
        profiles = [
            item for item in compute_projection_profiles(league)
            if (position == "ALL" or item.player.position == position)
            and (not query or query.lower() in item.player.name.lower() or query.lower() in item.player.team.lower())
        ]
        key = {
            "Expected points": lambda item: item.expected_points,
            "Ceiling": lambda item: item.ceiling,
            "Recent scoring": lambda item: item.recent_fppg if item.recent_fppg is not None else -1,
        }[sort_by]
        profiles.sort(key=key, reverse=True)
        st.caption("Expected points blend the current provider projection with recent and season scoring evidence. The range describes observed scoring variability, not a guarantee.")
        st.caption(f"Showing {min(len(profiles), 50)} of {len(profiles)} matching players")
        _section("Weekly outlook")
        for item in profiles[:50]:
            with st.container(border=True):
                heading, confidence = st.columns([3, 1])
                with heading:
                    _asset_heading(item.player.name, f"{item.player.position} · {item.player.team} · {item.role_trend} role")
                _compact_value(confidence, "Confidence", item.confidence)
                _stat_grid([
                    ("Expected", f"{item.expected_points:.1f}"),
                    ("Floor–ceiling", f"{item.floor:.1f}–{item.ceiling:.1f}"),
                    ("Recent FPPG", f"{item.recent_fppg:.1f}" if item.recent_fppg is not None else "—"),
                ])
                with st.expander("Projection evidence"):
                    for evidence in item.evidence:
                        st.write(f"• {evidence}")
        return
    recommendation = st.pills("Signal", ["ALL", "MODEL WELL ABOVE MARKET", "MODEL ABOVE MARKET", "MARKET ALIGNED", "MARKET ABOVE MODEL", "MARKET WELL ABOVE MODEL", "LOW CONFIDENCE"], default="ALL")
    results = [item for item in compute_projections(league) if (position == "ALL" or item.player.position == position) and (recommendation == "ALL" or item.recommendation == recommendation) and (not query or query.lower() in item.player.name.lower() or query.lower() in item.player.team.lower())]
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
            _stat_grid([("Role/production rank", item.edge_score), ("Market rank", item.market_score), ("Rank gap", f"{item.edge_delta:+d}")])
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
    backtest = backtest_projection_model(league)
    _section("Projection validation")
    if backtest.samples:
        _stat_grid([
            ("Walk-forward samples", backtest.samples),
            ("Blended MAE", f"{backtest.blended_mae:.2f}"),
            ("Vs baseline", f"{backtest.improvement:+.1%}"),
            ("Direction correct", f"{backtest.directional_accuracy:.0%}"),
        ])
        st.caption(f"{backtest.readiness}. Each week is predicted only from earlier completed weeks; future results are never included.")
        with st.expander("Accuracy by position"):
            for item in backtest.by_position:
                st.write(f"**{item.position}** · {item.samples} samples · {item.blended_mae:.2f} MAE · {item.improvement:+.1%} vs season-average baseline")
    else:
        st.info("At least four completed weekly stat lines per player are needed before walk-forward projection validation is available.")
    replay = backtest_recommendation_model(league)
    _section("Recommendation replay")
    if replay.samples:
        _stat_grid([
            ("Upgrade replays", replay.samples),
            ("Positive next week", f"{replay.success_rate:.0%}"),
            ("Actual lineup lift", f"{replay.average_actual_lift:+.2f}"),
            ("Predicted lift", f"{replay.average_predicted_lift:+.2f}"),
            ("False positives", f"{replay.false_positive_rate:.0%}"),
            ("Role failures", f"{replay.role_failure_rate:.0%}"),
        ])
        st.caption(
            f"{replay.readiness}. Walk-forward replay uses only earlier scoring to identify same-position lineup upgrades, "
            "then measures the following week's optimized lineup. Historical prices and manager acceptance are not reconstructed."
        )
        with st.expander("Replay by position"):
            for item in replay.by_position:
                st.write(
                    f"**{item.position}** · {item.samples} replays · {item.success_rate:.0%} positive · "
                    f"{item.average_actual_lift:+.2f} actual lineup points · {item.false_positive_rate:.0%} false positives"
                )
    else:
        st.info("Recommendation replay needs at least four completed weeks for multiple rostered players at the same position.")
    st.caption("Refresh the league from the top navigation after injuries, waivers, trades, or scoring corrections.")


def recommendations(league: League) -> None:
    league = _calibrated_trade_league(league)
    _page_header("Trade strategy", "Trade Finder", "Compare safe, balanced, and aggressive ways to improve your roster.")
    risk_profile = st.segmented_control(
        "Risk preference", ["Conservative", "Balanced", "Aggressive"], default="Balanced",
        help="Conservative protects depth; Aggressive prioritizes starter and playoff upside.",
    )
    position = st.pills("Target position", ["ALL", "QB", "RB", "WR", "TE"], default="ALL", key="recommendation_position")
    show_experimental = st.toggle(
        "Show D-grade experiments",
        value=False,
        help="D-grade packages are missing too much evidence to be normal review candidates.",
    )
    if league.trade_deadline_week is not None and league.current_week > league.trade_deadline_week and any(roster.games_played for roster in league.rosters):
        st.info(f"Your week {league.trade_deadline_week} trade deadline has passed. Trade Finder is paused so it does not present unavailable moves.")
        return
    with st.spinner("Evaluating realistic packages…"):
        all_ideas, search_performance = _cached_trade_finder(
            league, None if position == "ALL" else position, risk_profile, TRADE_FINDER_CACHE_VERSION,
        )
    ideas = [idea for idea in all_ideas if idea.confidence != "D" or show_experimental]
    if not ideas:
        st.info("No package currently offers enough strategic upside for this risk profile. Holding is preferable to forcing a trade.")
        st.caption(f"{search_performance.team_diagnosis or 'Team strategy'} · {search_performance.packages_evaluated} packages evaluated in {search_performance.elapsed_ms:,} ms")
        with st.expander("Recommendation funnel"):
            for reason, count in search_performance.rejection_counts:
                st.write(f"**{count}** · {reason}")
        with st.expander("Why no deal cleared the gates"):
            for note in recommendation_search_notes(league, None if position == "ALL" else position):
                st.write(f"• {note}")
        return
    objectives = list(dict.fromkeys(idea.objective for idea in ideas))
    if len(objectives) > 1:
        objective = st.pills("Move objective", ["ALL", *objectives], default="ALL", key="recommendation_objective")
        if objective != "ALL":
            ideas = [idea for idea in ideas if idea.objective == objective]
    if not ideas:
        st.info("No package matches that move objective and position. Choose another filter to see the available shortlist.")
        return
    qualified_ideas = [
        idea for idea in ideas
        if idea.tier != "Exploratory" and idea.confidence in {"A", "B"} and idea.evaluation.acceptance_score >= 48
    ]
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
            summary += f" · {review} exploratory"
        if experimental:
            summary += f" · {experimental} experimental"
        st.caption(summary)
    else:
        st.warning(f"No best-fit or {risk_profile.lower()} option surfaced. Showing {review} exploratory candidate{'s' if review != 1 else ''} with the tradeoffs exposed.")
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    my_context = build_contexts(league)[my_team.team_id]
    rank_detail = " · ".join(filter(None, [
        f"Record #{my_context.record_rank}" if my_context.record_rank is not None else None,
        f"Competitive #{my_context.league_rank}",
        f"Points #{my_context.points_rank}" if my_context.points_rank is not None else None,
        f"Assets #{my_context.asset_rank}",
    ]))
    st.markdown(f'<div class="insight"><strong>{html.escape(search_performance.team_diagnosis or "Team strategy")}</strong><br>{html.escape(rank_detail)}<br>{html.escape(risk_profile)} search · starter upside, playoff value, market cost, partner fit, and resilience are weighted together.</div>', unsafe_allow_html=True)
    st.caption(f"Search profile: {search_performance.packages_evaluated} packages evaluated · {search_performance.viable_candidates} viable before diversification · {search_performance.elapsed_ms:,} ms · cached until league data changes")
    with st.expander("Recommendation funnel"):
        if search_performance.rejection_counts:
            for reason, count in search_performance.rejection_counts:
                st.write(f"**{count}** · {reason}")
        else:
            st.caption("No candidate rejection details were recorded.")
    depth_pick_labels = [pick.label for idea in ideas if idea.kind == "DEPTH" for pick in idea.send_picks]
    shared_picks = sorted({label for label in depth_pick_labels if depth_pick_labels.count(label) > 1})
    if shared_picks:
        st.info(f"Alternative packages: {', '.join(shared_picks)} appears in multiple ideas. Choose one use of that pick, then refresh the plan after any completed move.")
    _section("Best available deals" if actionable else "Exploratory tradeoffs")
    for idea in ideas:
        with st.container(border=True):
            heading, score = st.columns([3, 1])
            with heading:
                prefix = idea.tier.upper() if idea in actionable_ideas else f"ALTERNATIVE · {idea.tier.upper()}" if idea in alternative_ideas else f"EXPLORATORY · {idea.objective.upper()}"
                _asset_heading(f"{prefix} · {idea.partner.team_name}", idea.reason)
            _compact_value(score, f"Evidence {idea.confidence}", f"{idea.score}/100")
            sends = [player.name for player in idea.send_players] + [pick.label for pick in idea.send_picks]
            receives = [player.name for player in idea.receive_players] + [pick.label for pick in idea.receive_picks]
            st.write(f"**Send:** {', '.join(sends) or 'Nothing'}")
            st.write(f"**Receive:** {', '.join(receives) or 'Nothing'}")
            playoff_gain = idea.evaluation.lineup_a.playoff_points_gained
            fairness = idea.evaluation.fairness
            market_balance = balance_label(fairness)
            partner_fit = "Strong" if idea.evaluation.acceptance_score >= 65 else "Neutral" if idea.evaluation.acceptance_score >= 48 else "Difficult"
            _stat_grid([("Market balance", market_balance), ("Your lineup", f"{idea.evaluation.lineup_a.points_gained:+.1f}"), ("Partner fit", partner_fit), ("Playoff lineup", f"{playoff_gain:+.1f}" if playoff_gain is not None else "Unavailable")])
            score_range = f"{idea.score_low}–{idea.score_high}" if idea.score_high else str(idea.score)
            st.caption(f"Team value {idea.team_value_score}/100 · Market value {idea.market_value_score}/100 · Overall recommendation {idea.score}/100 · confidence range {score_range}")
            if idea.evaluation.championship_probability_before is not None:
                st.caption(
                    f"Scenario estimate: playoffs {idea.evaluation.playoff_probability_before:.1f}% → {idea.evaluation.playoff_probability_after:.1f}% · "
                    f"championship {idea.evaluation.championship_probability_before:.1f}% → {idea.evaluation.championship_probability_after:.1f}% · not a forecast"
                )
            if idea.cautions:
                st.caption(f"Main risk: {idea.cautions[0]}")
            elif idea.evaluation.lineup_a.depth_change < 0:
                st.caption("Main risk: the move reduces roster resilience.")
            else:
                st.caption("Main risk: projections and player availability can change before kickoff.")
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


def _render_multi_step_paths(paths: list[object]) -> None:
    if not paths:
        return
    _section("Two-step acquisition paths")
    st.caption("Execute step two only after step one completes. Each first move is scored for whether it remains defensible if the target deal falls through.")
    for index, path in enumerate(paths, 1):
        with st.container(border=True):
            heading, score = st.columns([3, 1])
            with heading:
                _asset_heading(f"{index}. ACQUIRE {path.intermediary.name}, THEN CONVERT", f"Execution risk: {path.execution_risk}")
            _compact_value(score, "Path score", f"{path.score}/100")
            first_send = [player.name for player in path.first.send_players] + [pick.label for pick in path.first.send_picks]
            first_receive = [player.name for player in path.first.receive_players] + [pick.label for pick in path.first.receive_picks]
            second_send = [player.name for player in path.second.send_players] + [pick.label for pick in path.second.send_picks]
            second_receive = [player.name for player in path.second.receive_players] + [pick.label for pick in path.second.receive_picks]
            st.markdown(f"**Step 1 · {path.first.partner.team_name}**")
            st.write(f"Send {', '.join(first_send)} → Receive {', '.join(first_receive)}")
            st.caption(f"Partner fit {path.first.evaluation.acceptance_score}/100 · standalone score {path.first.score}/100")
            st.markdown(f"**Step 2 · {path.second.partner.team_name}**")
            st.write(f"Send {', '.join(second_send)} → Receive {', '.join(second_receive)}")
            st.caption(f"Partner fit {path.second.evaluation.acceptance_score}/100 · offer score {path.second.score}/100")
            _stat_grid([
                ("Final lineup", f"{path.final_lineup_delta:+.1f}"),
                ("Final playoffs", f"{path.final_playoff_delta:+.1f}" if path.final_playoff_delta is not None else "—"),
                ("Stop after step 1", "Safe" if path.stop_after_step_one_safe else "Risky"),
            ])
            if not path.stop_after_step_one_safe:
                st.warning("Step one is not attractive enough as a standalone move. Treat this as an aggressive, coordinated path only.")
            st.button(
                "Open step 1 in Trade Simulator", key=f"path-open-{path.intermediary.id}-{index}",
                use_container_width=True, on_click=_load_recommendation, args=(path.first,),
            )


def _sell_seeker(league: League, my_team: Roster, risk_profile: str) -> None:
    roster_players = {player.id: player for player in active_roster_players(my_team) if player.position in {"QB", "RB", "WR", "TE"}}
    player_id = st.selectbox(
        "Player to move", options=sorted(roster_players, key=lambda item: roster_players[item].name),
        index=None, placeholder="Search your roster",
        format_func=lambda item: f"{roster_players[item].name} · {roster_players[item].position} · Value {roster_players[item].value:.0f}",
    )
    if player_id is None:
        st.caption("Select a player from your depth chart to find the best destinations and returns.")
        return
    player = roster_players[player_id]
    with st.spinner(f"Finding markets for {player.name}…"):
        offers, performance = generate_sell_offers(league, player_id, risk_profile=risk_profile)
    st.markdown(
        f'<div class="insight"><strong>Move {html.escape(player.name)} · {html.escape(player.position)}</strong><br>'
        f'Market value {player.value:.0f} · {html.escape(risk_profile)} return construction</div>', unsafe_allow_html=True,
    )
    st.caption(f"{performance.packages_evaluated} returns evaluated · {performance.viable_candidates} viable · {performance.elapsed_ms:,} ms")
    if not offers:
        st.warning("No destination currently returns enough team value while clearing market, partner-fit, and roster-safety checks.")
        with st.expander("What blocked the exits"):
            for reason, count in performance.rejection_counts:
                st.write(f"**{count}** · {reason}")
        return
    _section("Best destinations")
    my_context = build_contexts(league)[my_team.team_id]
    for index, idea in enumerate(offers, 1):
        with st.container(border=True):
            heading, score = st.columns([3, 1])
            with heading:
                _asset_heading(f"{index}. {idea.tier.upper()} · {idea.partner.team_name}", idea.reason)
            _compact_value(score, f"Evidence {idea.confidence}", f"{idea.score}/100")
            receives = [asset.name for asset in idea.receive_players] + [pick.label for pick in idea.receive_picks]
            st.write(f"**Send:** {player.name}")
            st.write(f"**Receive:** {', '.join(receives)}")
            _stat_grid([
                ("Market balance", balance_label(idea.evaluation.fairness)),
                ("Your lineup", f"{idea.evaluation.lineup_a.points_gained:+.1f}"),
                ("Partner fit", f"{idea.evaluation.acceptance_score}/100"),
                ("Playoff lineup", f"{idea.evaluation.lineup_a.playoff_points_gained:+.1f}" if idea.evaluation.lineup_a.playoff_points_gained is not None else "—"),
            ])
            if idea.cautions:
                st.caption(f"Main risk: {idea.cautions[0]}")
            st.button("Open in Trade Simulator", key=f"sell-open-{player.id}-{index}", use_container_width=True, on_click=_load_recommendation, args=(idea,))
            if st.button("Save to journal", key=f"sell-save-{player.id}-{index}", use_container_width=True):
                decision = trade_snapshot(
                    league, my_team, idea.partner, idea.send_players, idea.receive_players,
                    idea.send_picks, idea.receive_picks, idea.evaluation, my_context,
                    source="player_seller", confidence=idea.confidence, score=idea.score,
                    score_breakdown=idea.score_breakdown,
                )
                try:
                    save_decision(current_user_id(), decision)
                    st.success("Sell option saved with its model snapshot.")
                except StorageError as exc:
                    st.error(str(exc))


def player_seeker(league: League) -> None:
    league = _calibrated_trade_league(league)
    _page_header("Goal-directed trades", "Player Seeker", "Acquire an exact target, build a safe two-step path, or find the best market for a player you want to move.")
    my_team = next(roster for roster in league.rosters if roster.team_id == league.my_team_id)
    mode = st.segmented_control("Objective", ["Acquire", "Move"], default="Acquire", key="seeker_objective")
    risk_profile = st.segmented_control(
        "Offer style", ["Conservative", "Balanced", "Aggressive"], default="Balanced",
        help="Conservative protects depth; Aggressive is more willing to pay for concentrated upside.",
        key="seeker_risk_profile",
    )
    if league.trade_deadline_week is not None and league.current_week > league.trade_deadline_week and any(roster.games_played for roster in league.rosters):
        st.info(f"Your week {league.trade_deadline_week} trade deadline has passed, so goal-directed trade paths are paused.")
        return
    if mode == "Move":
        _sell_seeker(league, my_team, risk_profile)
        return
    available = {
        player.id: (player, roster)
        for roster in league.rosters if roster.team_id != my_team.team_id
        for player in active_roster_players(roster)
    }
    if not available:
        st.info("No rostered players are currently available to target.")
        return
    target_id = st.selectbox(
        "Target player",
        options=sorted(available, key=lambda player_id: available[player_id][0].name),
        index=None,
        placeholder="Search for a player",
        format_func=lambda player_id: f"{available[player_id][0].name} · {available[player_id][0].position} · {available[player_id][1].team_name}",
    )
    if target_id is None:
        st.caption("Select any player held by another manager to calculate direct acquisition paths.")
        return
    target, owner = available[target_id]
    with st.spinner(f"Building paths to {target.name}…"):
        offers, performance = generate_target_offers(league, target_id, risk_profile=risk_profile)
    multi_step_paths: list[object] = []
    if not offers or max(idea.score for idea in offers) < 65:
        with st.spinner(f"Checking safe two-step routes to {target.name}…"):
            multi_step_paths = generate_multi_step_paths(league, target_id, risk_profile=risk_profile)
    st.markdown(
        f'<div class="insight"><strong>{html.escape(target.name)} · {html.escape(target.position)}</strong><br>'
        f'Rostered by {html.escape(owner.team_name)} · Market value {target.value:.0f}<br>'
        f'{html.escape(risk_profile)} offer construction</div>',
        unsafe_allow_html=True,
    )
    st.caption(f"{performance.packages_evaluated} offers evaluated · {performance.viable_candidates} credible before diversification · {performance.elapsed_ms:,} ms")
    if not offers and not multi_step_paths:
        st.warning("No credible direct offer clears the market, partner-fit, lineup, and roster-safety checks right now.")
        with st.expander("What blocked the direct paths"):
            for reason, count in performance.rejection_counts:
                st.write(f"**{count}** · {reason}")
        st.caption("No safe two-step route was found either; the engine will not recommend getting stranded with an intermediary that hurts your roster.")
        return
    if not offers:
        st.warning("No credible direct offer clears every gate. The paths below use a defensible intermediary required by the target manager.")
        with st.expander("What blocked the direct paths"):
            for reason, count in performance.rejection_counts:
                st.write(f"**{count}** · {reason}")
        _render_multi_step_paths(multi_step_paths)
        return
    _section("Best acquisition paths")
    my_context = build_contexts(league)[my_team.team_id]
    for index, idea in enumerate(offers, 1):
        with st.container(border=True):
            heading, score = st.columns([3, 1])
            with heading:
                _asset_heading(f"{index}. {idea.tier.upper()} · {owner.team_name}", idea.reason)
            _compact_value(score, f"Evidence {idea.confidence}", f"{idea.score}/100")
            sends = [player.name for player in idea.send_players] + [pick.label for pick in idea.send_picks]
            receives = [player.name for player in idea.receive_players] + [pick.label for pick in idea.receive_picks]
            st.write(f"**Offer:** {', '.join(sends)}")
            st.write(f"**Receive:** {', '.join(receives)}")
            result = idea.evaluation
            _stat_grid([
                ("Market balance", balance_label(result.fairness)),
                ("Your lineup", f"{result.lineup_a.points_gained:+.1f}"),
                ("Partner fit", f"{result.acceptance_score}/100"),
                ("Playoff lineup", f"{result.lineup_a.playoff_points_gained:+.1f}" if result.lineup_a.playoff_points_gained is not None else "Unavailable"),
            ])
            score_range = f"{idea.score_low}–{idea.score_high}" if idea.score_high else str(idea.score)
            st.caption(f"Team value {idea.team_value_score}/100 · Market value {idea.market_value_score}/100 · Overall path {idea.score}/100 · confidence range {score_range}")
            if result.championship_probability_before is not None:
                st.caption(
                    f"Scenario estimate: playoffs {result.playoff_probability_before:.1f}% → {result.playoff_probability_after:.1f}% · "
                    f"championship {result.championship_probability_before:.1f}% → {result.championship_probability_after:.1f}% · not a forecast"
                )
            if result.lineup_a.points_gained < 0:
                st.caption(f"Main tradeoff: acquiring the target lowers the modeled current lineup by {abs(result.lineup_a.points_gained):.1f} PPG before future-value considerations.")
            elif idea.cautions:
                st.caption(f"Main risk: {idea.cautions[0]}")
            with st.expander("Why this path works—and what could block it"):
                for item in idea.evidence:
                    st.write(f"✓ {item}")
                for item in idea.cautions:
                    st.write(f"! {item}")
                st.markdown("**Score breakdown**")
                for label, contribution in idea.score_breakdown:
                    st.write(f"{label}: {contribution:+.1f}")
            st.button(
                "Open in Trade Simulator", key=f"seek-open-{target.id}-{index}", use_container_width=True,
                on_click=_load_recommendation, args=(idea,),
            )
            if st.button("Save to journal", key=f"seek-save-{target.id}-{index}", use_container_width=True):
                decision = trade_snapshot(
                    league, my_team, owner, idea.send_players, idea.receive_players,
                    idea.send_picks, idea.receive_picks, result, my_context,
                    source="player_seeker", confidence=idea.confidence, score=idea.score,
                    score_breakdown=idea.score_breakdown,
                )
                try:
                    save_decision(current_user_id(), decision)
                    st.success("Target offer saved with its model snapshot.")
                except StorageError as exc:
                    st.error(str(exc))
    _render_multi_step_paths(multi_step_paths)


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
    league = _calibrated_trade_league(league)
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
    a_pick_options = {f"{pick.label} · {pick_profile(pick, league).projection} · {pick_profile(pick, league).class_outlook} · {format_value(pick_profile(pick, league).adjusted_value)}": pick for pick in team_a.draft_picks}
    b_pick_options = {f"{pick.label} · {pick_profile(pick, league).projection} · {pick_profile(pick, league).class_outlook} · {format_value(pick_profile(pick, league).adjusted_value)}": pick for pick in team_b.draft_picks}
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
    counter_signature = (
        team_b.team_id,
        tuple(sorted(player.id for player in selected_a_players)),
        tuple(sorted(player.id for player in selected_b_players)),
        tuple(sorted((pick.year, pick.round, pick.original_owner) for pick in selected_a_picks)),
        tuple(sorted((pick.year, pick.round, pick.original_owner) for pick in selected_b_picks)),
    )
    if st.button("Build counteroffers", use_container_width=True):
        counters = generate_counteroffers(
            team_a, team_b, selected_a_players, selected_b_players, league,
            selected_a_picks, selected_b_picks, trade_contexts,
        )
        st.session_state.trade_counter_signature = counter_signature
        st.session_state.trade_counteroffers = counters
    counters = st.session_state.get("trade_counteroffers", []) if st.session_state.get("trade_counter_signature") == counter_signature else []
    if st.session_state.get("trade_counter_signature") == counter_signature and not counters:
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
    report = build_calibration_report(saved)
    _stat_grid([
        ("Tracked", report.tracked),
        ("Positive outcome", f"{report.positive_rate:.0%}" if report.positive_rate is not None else "—"),
        ("Avg PPG error", f"{report.mean_absolute_error:.1f}" if report.mean_absolute_error is not None else "—"),
        ("Direction correct", f"{report.directional_accuracy:.0%}" if report.directional_accuracy is not None else "—"),
    ])
    st.caption(f"{report.readiness} · {report.resolved} resolved decisions · {report.observed} with observed lineup impact")
    if report.partner_observed:
        bias = report.partner_fit_bias or 0.0
        direction = "optimistic" if bias > 1 else "conservative" if bias < -1 else "well centered"
        st.caption(
            f"Partner calibration · {report.partner_observed} resolved offers · "
            f"Brier {report.partner_brier_score:.3f} (lower is better) · "
            f"fit estimate {abs(bias):.1f} points {direction}"
        )
    with st.expander("Calibration by evidence grade"):
        for item in report.by_confidence:
            outcome = f"{item.positive_rate:.0%} positive" if item.positive_rate is not None else "No resolved outcomes"
            st.write(f"**{item.label}** · {item.tracked} tracked · {item.resolved} resolved · {outcome}")
        if report.useful_feedback_rate is not None:
            st.caption(f"{report.useful_feedback_rate:.0%} of explicit model feedback marked the recommendation useful.")
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
                has_observation = outcome.get("actual_lineup_change") is not None or outcome.get("actual_value_change") is not None
                record_observation = st.checkbox("Record observed impact", value=has_observation, help="Leave this off until you have a real post-decision result. Missing outcomes are not treated as zero.")
                actual_lineup = st.number_input("Observed lineup change (PPG)", value=float(outcome.get("actual_lineup_change") or 0), step=0.1, disabled=not record_observation)
                actual_value = st.number_input("Observed market-value change", value=float(outcome.get("actual_value_change") or 0), step=1.0, disabled=not record_observation)
                notes = st.text_input("Outcome notes", value=str(outcome.get("notes") or ""))
                if st.form_submit_button("Update outcome", use_container_width=True):
                    try:
                        updated_outcome = {"notes": notes}
                        if record_observation:
                            updated_outcome.update({"actual_lineup_change": actual_lineup, "actual_value_change": actual_value})
                        update_decision(current_user_id(), str(item["id"]), {"status": status, "feedback": feedback or None, "outcome": updated_outcome})
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
