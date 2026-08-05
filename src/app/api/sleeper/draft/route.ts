import {
  getSleeperUser,
  getSleeperLeague,
  getSleeperLeagueUsers,
  getSleeperRosters,
  getSleeperPlayers,
  getSleeperDrafts,
  getSleeperDraft,
  getSleeperDraftPicks,
  getSleeperTradedPicks,
  type SleeperDraft,
} from "@/lib/sleeper-api";
import {
  getFantasyCalcValues,
  applyTePremium,
  normalizeName,
} from "@/lib/fantasycalc";
import { NextRequest } from "next/server";

// Build a flat array of roster_ids indexed by (pick_no - 1).
function buildPickOrder(draft: SleeperDraft): number[] {
  const teams = draft.settings.teams;
  const rounds = draft.settings.rounds;
  const slotToRoster = draft.slot_to_roster_id || {};
  const isSnake = draft.type === "snake";
  const order: number[] = [];

  for (let r = 1; r <= rounds; r++) {
    const slots: number[] = [];
    for (let s = 1; s <= teams; s++) slots.push(s);
    if (isSnake && r % 2 === 0) slots.reverse();
    for (const s of slots) {
      order.push(slotToRoster[String(s)]);
    }
  }
  return order;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const leagueId = searchParams.get("leagueId");
  const username = searchParams.get("username");

  if (!leagueId || !username) {
    return Response.json(
      { error: "leagueId and username are required" },
      { status: 400 }
    );
  }

  try {
    const [user, league, leagueUsers, rosterData, allPlayers, drafts] =
      await Promise.all([
        getSleeperUser(username),
        getSleeperLeague(leagueId),
        getSleeperLeagueUsers(leagueId),
        getSleeperRosters(leagueId),
        getSleeperPlayers(),
        getSleeperDrafts(leagueId),
      ]);

    if (!drafts || drafts.length === 0) {
      return Response.json({ error: "No draft found for this league" }, { status: 404 });
    }

    const draftId = drafts[0].draft_id;
    const [draft, picks, tradedPicks] = await Promise.all([
      getSleeperDraft(draftId),
      getSleeperDraftPicks(draftId),
      getSleeperTradedPicks(leagueId),
    ]);

    // League format for value tuning
    const superflex = (league.roster_positions || []).includes("SUPER_FLEX");
    const tePremiumBonus = league.scoring_settings?.bonus_rec_te || 0;
    const ppr =
      (league.scoring_settings?.rec || 0) >= 1
        ? 1
        : (league.scoring_settings?.rec || 0) >= 0.5
          ? 0.5
          : 0;

    let fcValues: Awaited<ReturnType<typeof getFantasyCalcValues>> | null = null;
    try {
      fcValues = await getFantasyCalcValues({
        isDynasty: true,
        numQbs: superflex ? 2 : 1,
        numTeams: league.total_rosters || 12,
        ppr,
      });
    } catch (e) {
      console.error("FantasyCalc fetch failed:", e);
    }

    const valueFor = (sleeperId: string, name: string, position: string): number => {
      const entry =
        fcValues?.bySleeperId[sleeperId] ||
        fcValues?.byName[normalizeName(name)];
      if (!entry) return 0;
      return applyTePremium(entry.value, position, tePremiumBonus);
    };

    // Team name lookup
    const userMap = new Map<string, any>();
    for (const u of leagueUsers) userMap.set(u.user_id, u);
    const rosterToOwner = new Map<number, any>();
    for (const r of rosterData) {
      rosterToOwner.set(r.roster_id, userMap.get(r.owner_id));
    }
    const teamName = (rosterId: number): string => {
      const owner = rosterToOwner.get(rosterId);
      return owner?.metadata?.team_name || owner?.display_name || `Team ${rosterId}`;
    };

    const myRoster = rosterData.find((r: any) => r.owner_id === user.user_id);
    const myRosterId = myRoster?.roster_id ?? null;

    // Draft order + pick math
    const pickOrder = buildPickOrder(draft);
    const totalPicks = pickOrder.length;
    const picksMade = picks.length;
    const isComplete = draft.status === "complete" || picksMade >= totalPicks;
    const currentPickNo = isComplete ? null : picksMade + 1;

    // Build a map of (roster_id, round) -> owner_id from traded_picks
    // traded_picks has: roster_id (original owner), owner_id (current owner), round, season
    const tradeMap = new Map<string, number>(); // key: "roster_id-round-season", value: owner_id
    for (const tp of tradedPicks || []) {
      if (tp.season === draft.season) {
        const key = `${tp.roster_id}-${tp.round}-${tp.season}`;
        tradeMap.set(key, tp.owner_id);
      }
    }

    // Function to get the actual owner of a pick slot
    const getPickOwner = (pickNo: number): number => {
      const teams = draft.settings?.teams || 14;
      const round = Math.ceil(pickNo / teams);
      const originalRosterId = pickOrder[pickNo - 1];
      const key = `${originalRosterId}-${round}-${draft.season}`;
      return tradeMap.get(key) ?? originalRosterId;
    };

    const onClockRosterId =
      currentPickNo && currentPickNo <= totalPicks ? getPickOwner(currentPickNo) : null;

    // My upcoming picks - check traded picks first, then original order
    const myUpcomingPicks: number[] = [];
    for (let i = picksMade; i < totalPicks; i++) {
      const pickNo = i + 1;
      const rosterId = getPickOwner(pickNo);
      if (rosterId === myRosterId) myUpcomingPicks.push(pickNo);
    }
    const myNextPickNo = myUpcomingPicks[0] ?? null;
    const picksUntilMyTurn =
      myNextPickNo && currentPickNo ? myNextPickNo - currentPickNo : null;

    // Drafted player ids
    const draftedIds = new Set(picks.map((p) => p.player_id));

    // Recent picks (enriched, most recent first)
    const recentPicks = [...picks]
      .sort((a, b) => b.pick_no - a.pick_no)
      .slice(0, 12)
      .map((p) => {
        const name = `${p.metadata.first_name} ${p.metadata.last_name}`;
        return {
          pickNo: p.pick_no,
          round: p.round,
          slot: p.draft_slot,
          playerName: name,
          position: p.metadata.position,
          team: p.metadata.team,
          rosterId: p.roster_id,
          teamName: teamName(p.roster_id),
          value: valueFor(p.player_id, name, p.metadata.position),
          isMine: p.roster_id === myRosterId,
        };
      });

    // Best available rookies (years_exp === 0, not drafted, has a value)
    const bestAvailable = Object.entries(allPlayers)
      .filter(([id, pd]) => {
        if (draftedIds.has(id)) return false;
        if (pd.years_exp !== 0) return false;
        if (!["QB", "RB", "WR", "TE"].includes(pd.position)) return false;
        return true;
      })
      .map(([id, pd]) => {
        const name = `${pd.first_name} ${pd.last_name}`;
        const entry =
          fcValues?.bySleeperId[id] || fcValues?.byName[normalizeName(name)];
        return {
          id,
          name,
          position: pd.position,
          team: pd.team || "FA",
          age: pd.age || null,
          value: entry ? applyTePremium(entry.value, pd.position, tePremiumBonus) : 0,
          positionRank: entry?.positionRank ?? null,
          overallRank: entry?.overallRank ?? null,
          trend30Day: entry?.trend30Day ?? 0,
        };
      })
      .filter((p) => p.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 60);

    // My current roster positional counts (from existing rostered players)
    const myPositionCounts: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
    if (myRoster) {
      for (const pid of myRoster.players || []) {
        const pos = allPlayers[pid]?.position;
        if (pos && myPositionCounts[pos] !== undefined) myPositionCounts[pos]++;
      }
    }
    // Add players I've drafted in this draft
    for (const p of picks) {
      if (p.roster_id === myRosterId) {
        const pos = p.metadata.position;
        if (myPositionCounts[pos] !== undefined) myPositionCounts[pos]++;
      }
    }

    return Response.json({
      draft: {
        id: draftId,
        status: draft.status,
        type: draft.type,
        season: draft.season,
        rounds: draft.settings.rounds,
        teams: draft.settings.teams,
      },
      meta: {
        totalPicks,
        picksMade,
        isComplete,
        currentPickNo,
        currentRound: currentPickNo ? Math.ceil(currentPickNo / draft.settings.teams) : null,
        lastPicked: draft.last_picked || null,
      },
      onClock: onClockRosterId
        ? { rosterId: onClockRosterId, teamName: teamName(onClockRosterId), isMine: onClockRosterId === myRosterId }
        : null,
      me: {
        rosterId: myRosterId,
        teamName: myRosterId ? teamName(myRosterId) : null,
        nextPickNo: myNextPickNo,
        picksUntilMyTurn,
        upcomingPicks: myUpcomingPicks,
        positionCounts: myPositionCounts,
      },
      recentPicks,
      bestAvailable,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
