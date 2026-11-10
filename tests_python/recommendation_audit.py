"""Deterministic human-sense audit for recommendation output.

Run with: python3 -m tests_python.recommendation_audit
"""
from __future__ import annotations

from python_app.models import DraftPick, League, Player, Roster
from python_app.recommendations import generate_target_offers, timed_generate_recommendations


def player(identifier: str, name: str, position: str, value: float, points: float, age: int = 25, status: str | None = None) -> tuple[Player, float]:
    return Player(identifier, name, position, "NFL", age, value, status), points


def build_audit_league() -> League:
    rows = {
        "mine": [
            player("maye", "Drake Maye", "QB", 76, 22), player("dak", "Dak Prescott", "QB", 43, 19, 33),
            player("kyren", "Kyren Williams", "RB", 58, 16), player("warren", "Jaylen Warren", "RB", 24, 10),
            player("white", "Rachaad White", "RB", 18, 8), player("waddle", "Jaylen Waddle", "WR", 48, 13),
            player("diggs", "Stefon Diggs", "WR", 19, 9, 32), player("depthwr", "Depth WR", "WR", 12, 7),
            player("depthwr2", "Depth WR Two", "WR", 9, 6), player("depthqb", "Depth QB", "QB", 10, 13),
            player("twarren", "Tyler Warren", "TE", 38, 11), player("depthte", "Depth TE", "TE", 8, 5),
        ],
        "quarterbacks": [
            player("tlaw", "Trevor Lawrence", "QB", 30, 18), player("backupqb", "Backup QB", "QB", 12, 14),
            player("rb1", "Partner RB One", "RB", 42, 13), player("rb2", "Partner RB Two", "RB", 20, 8),
            player("wr1", "Partner WR One", "WR", 45, 14), player("boston", "Denzel Boston", "WR", 15, 8),
            player("wr3", "Partner WR Three", "WR", 13, 7), player("te1", "Partner TE", "TE", 28, 8),
        ],
        "elitewr": [
            player("qb3", "Third QB", "QB", 35, 17), player("rb3", "Third RB", "RB", 35, 12),
            player("rb4", "Third RB Two", "RB", 22, 9), player("nabers", "Malik Nabers", "WR", 68, 18),
            player("wr4", "Third WR", "WR", 25, 10), player("wr5", "Third WR Two", "WR", 16, 8),
            player("te3", "Third TE", "TE", 30, 9),
        ],
        "injured": [
            player("love", "Jordan Love", "QB", 48, 0, 28, "IR"), player("rb5", "Fourth RB", "RB", 40, 13),
            player("rb6", "Fourth RB Two", "RB", 18, 8), player("adams", "Davante Adams", "WR", 32, 0, 33, "IR"),
            player("wr6", "Fourth WR", "WR", 28, 11), player("wr7", "Fourth WR Two", "WR", 18, 8),
            player("te4", "Fourth TE", "TE", 27, 8),
        ],
        "depth": [
            player("qb5", "Fifth QB", "QB", 32, 17), player("rb7", "Fifth RB", "RB", 37, 12),
            player("rb8", "Fifth RB Two", "RB", 21, 9), player("wr8", "Fifth WR", "WR", 39, 13),
            player("wr9", "Fifth WR Two", "WR", 23, 9), player("te5", "Fifth TE", "TE", 34, 10),
        ],
        "balanced": [
            player("qb6", "Sixth QB", "QB", 38, 18), player("rb9", "Sixth RB", "RB", 39, 13),
            player("rb10", "Sixth RB Two", "RB", 19, 8), player("wr10", "Sixth WR", "WR", 41, 13),
            player("wr11", "Sixth WR Two", "WR", 24, 9), player("te6", "Sixth TE", "TE", 31, 9),
        ],
    }
    rosters: list[Roster] = []
    weekly: dict[str, float] = {}
    records = ((4, 5, 980), (6, 3, 1080), (5, 4, 1040), (3, 6, 900), (7, 2, 1110), (4, 5, 960))
    for index, (key, assets) in enumerate(rows.items(), 1):
        players = tuple(asset for asset, _ in assets)
        weekly.update({asset.id: points for asset, points in assets})
        wins, losses, scored = records[index - 1]
        picks = (DraftPick(2027, 1, str(index), str(index), 32), DraftPick(2027, 2, str(index), str(index), 14))
        rosters.append(Roster(str(index), key.title(), key, players, picks, wins=wins, losses=losses, points_for=scored))
    return League(
        "audit", "Recommendation Audit", "2026", "dynasty", 6, True, False, "half_ppr",
        (("QB", 1), ("RB", 2), ("WR", 3), ("TE", 1), ("FLEX", 1), ("SUPERFLEX", 1), ("BN", 8)),
        "1", tuple(rosters), "live", current_week=10, weekly_points=weekly,
        playoff_weekly_points={15: weekly, 16: weekly, 17: weekly},
        manager_tendencies={str(index): {"trades": 3} for index in range(1, 7)},
    )


def format_offer(idea: object) -> str:
    sends = ", ".join([*(player.name for player in idea.send_players), *(pick.label for pick in idea.send_picks)])
    receives = ", ".join([*(player.name for player in idea.receive_players), *(pick.label for pick in idea.receive_picks)])
    return f"{idea.tier:14} {idea.score:>3}/100 | send {sends} | receive {receives} | market {idea.evaluation.fairness:+.1f}% | partner {idea.evaluation.acceptance_score} | lineup {idea.evaluation.lineup_a.points_gained:+.1f}"


def run() -> None:
    league = build_audit_league()
    ideas, finder_performance = timed_generate_recommendations(
        league, limit=8, include_low_confidence=True, include_review_candidates=True,
    )
    print("TRADE FINDER")
    for idea in ideas:
        print(format_offer(idea))
    print(f"evaluated={finder_performance.packages_evaluated} viable={finder_performance.viable_candidates} rejected={finder_performance.rejection_counts}")
    print("\nPLAYER SEEKER: TREVOR LAWRENCE")
    offers, performance = generate_target_offers(league, "tlaw")
    for offer in offers:
        print(format_offer(offer))
    print(f"evaluated={performance.packages_evaluated} viable={performance.viable_candidates} rejected={performance.rejection_counts}")

    print("\nPLAYER SEEKER: MALIK NABERS")
    nabers_offers, nabers_performance = generate_target_offers(league, "nabers")
    for offer in nabers_offers:
        print(format_offer(offer))
    print(f"evaluated={nabers_performance.packages_evaluated} viable={nabers_performance.viable_candidates} rejected={nabers_performance.rejection_counts}")

    surfaced = [*ideas, *offers, *nabers_offers]
    unavailable = {"out", "o", "ir", "pup", "nfi", "suspended", "sus", "doubtful", "d"}
    assert all(sum((player.injury_status or "").lower() in unavailable for player in idea.receive_players) < 2 for idea in surfaced)
    assert all(offer.evaluation.acceptance_score >= 45 for offer in offers)
    assert all(any(player.id == "tlaw" for player in offer.receive_players) for offer in offers)
    assert len({(idea.partner.team_id, tuple(sorted(player.id for player in idea.send_players)), tuple(sorted(player.id for player in idea.receive_players))) for idea in ideas}) == len(ideas)


if __name__ == "__main__":
    run()
