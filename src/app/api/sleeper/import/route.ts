import {
  getSleeperUser,
  getSleeperLeague,
  getSleeperRosters,
  getSleeperLeagueUsers,
  getSleeperPlayers,
  getSleeperTradedPicks,
  getSleeperDrafts,
  mapSleeperPositions,
} from "@/lib/sleeper-api";
import { DEFAULT_DYNASTY_VALUES } from "@/lib/player-values";
import {
  getFantasyCalcValues,
  getFantasyCalcPickValues,
  valuePick,
  applyTePremium,
  normalizeName,
} from "@/lib/fantasycalc";
import { analyzeHistoricalTrades } from "@/lib/trade-analysis";
import { NextRequest } from "next/server";
import type { Player, TeamRoster, LeagueSettings, RosterSlot, DraftPick, HistoricalTradeAnalysis } from "@/types";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const leagueId = searchParams.get("leagueId");
  const username = searchParams.get("username");

  console.log(`[Import] Starting import for league ${leagueId}, user ${username}`);

  if (!leagueId || !username) {
    return Response.json(
      { error: "leagueId and username are required" },
      { status: 400 }
    );
  }

  try {
    const [user, league, rosterData, leagueUsers, allPlayers, drafts] =
      await Promise.all([
        getSleeperUser(username),
        getSleeperLeague(leagueId),
        getSleeperRosters(leagueId),
        getSleeperLeagueUsers(leagueId),
        getSleeperPlayers(),
        getSleeperDrafts(leagueId).catch(() => []),
      ]);

    console.log(`[Import] Fetched basic data`);

    let tradedPicks: any[] = [];
    try {
      tradedPicks = await getSleeperTradedPicks(leagueId);
    } catch {
      // traded picks may not be available
    }

    // Map roster positions
    const { superflex, rosterSlots } = mapSleeperPositions(
      league.roster_positions || []
    );

    // Detect TE premium
    const tePremium =
      (league.scoring_settings?.bonus_rec_te || 0) > 0 ||
      (league.scoring_settings?.rec_te || 0) >
        (league.scoring_settings?.rec || 0);
    const tePremiumBonus = league.scoring_settings?.bonus_rec_te || 0;

    const ppr =
      (league.scoring_settings?.rec || 0) >= 1
        ? 1
        : (league.scoring_settings?.rec || 0) >= 0.5
          ? 0.5
          : 0;

    // Build league settings
    const leagueSettings: LeagueSettings = {
      id: league.league_id,
      name: league.name,
      platform: "sleeper",
      teamCount: league.total_rosters,
      rosterSlots: rosterSlots as RosterSlot[],
      scoringType: ppr >= 1 ? "ppr" : ppr >= 0.5 ? "half_ppr" : "standard",
      tePremium,
      tePremiumBonus,
      superflex,
      taxiSquadSlots: league.settings?.taxi_slots || 0,
      irSlots: league.settings?.reserve_slots || 0,
    };

    // Fetch real dynasty values + pick values from FantasyCalc, tuned to format
    const fcParams = {
      isDynasty: true,
      numQbs: superflex ? 2 : 1,
      numTeams: league.total_rosters || 12,
      ppr,
    };
    let fcValues: Awaited<ReturnType<typeof getFantasyCalcValues>> | null = null;
    let pickLookup: Awaited<ReturnType<typeof getFantasyCalcPickValues>> | null = null;
    try {
      [fcValues, pickLookup] = await Promise.all([
        getFantasyCalcValues(fcParams),
        getFantasyCalcPickValues(fcParams),
      ]);
    } catch (e) {
      console.error("FantasyCalc fetch failed, falling back to defaults:", e);
    }

    // Build player map - prefer FantasyCalc values (by Sleeper ID, then name),
    // falling back to the local default database, then a baseline.
    const players: Record<string, Player> = {};
    for (const [id, pData] of Object.entries(allPlayers)) {
      // Use fantasy_positions array for more accurate position data
      const position = (pData.fantasy_positions?.[0] || pData.position) as Player["position"];
      if (!position || !["QB", "RB", "WR", "TE", "K", "DEF"].includes(position)) continue;
      const fullName = `${pData.first_name} ${pData.last_name}`;

      let dynastyValue = 0;
      const fcEntry =
        fcValues?.bySleeperId[id] ||
        fcValues?.byName[normalizeName(fullName)];
      if (fcEntry) {
        dynastyValue = applyTePremium(fcEntry.value, position, tePremiumBonus);
      } else {
        dynastyValue = DEFAULT_DYNASTY_VALUES[fullName] || 0;
      }

      players[id] = {
        id,
        name: fullName,
        position,
        team: pData.team || "FA",
        age: pData.age || 0,
        dynastyValue,
        injuryStatus: pData.injury_status || undefined,
      };
    }

    // Build rosters
    const userMap = new Map<string, any>();
    for (const u of leagueUsers) {
      userMap.set(u.user_id, u);
    }

    // --- Draft pick capital ---------------------------------------------------
    // Determine draft format + the next future rookie classes to model.
    const draftRounds = Math.min(drafts?.[0]?.settings?.rounds ?? 3, 3);
    const teamCount = league.total_rosters || rosterData.length;
    const currentDraftYear = parseInt(
      drafts?.[0]?.season || league.season || String(new Date().getFullYear())
    );
    // Future tradeable picks are the next three rookie classes after the one
    // currently drafting.
    const futureYears = [1, 2, 3].map((n) => currentDraftYear + n);

    // Project each team's draft slot from roster strength (weakest picks first).
    // strengthScore = sum of top-12 player values (rough starter proxy).
    const strengthRanked = rosterData
      .map((r: any) => {
        const vals = (r.players || [])
          .map((pid: string) => players[pid]?.dynastyValue || 0)
          .sort((a: number, b: number) => b - a)
          .slice(0, 12);
        const score = vals.reduce((s: number, v: number) => s + v, 0);
        return { rosterId: r.roster_id, score };
      })
      .sort((a, b) => b.score - a.score);
    // strengthRanked[0] = strongest team -> finishes first -> picks LATE
    // (projectedSlotPct ~1, lower value). Weakest team picks early (~0, higher).
    const slotPctByRoster = new Map<number, number>();
    strengthRanked.forEach((x, i) => {
      const pct = teamCount > 1 ? 1 - i / (teamCount - 1) : 0.5;
      slotPctByRoster.set(x.rosterId, pct);
    });

    // Default ownership: every team owns its own pick each (year, round).
    const pickCapital = new Map<number, DraftPick[]>();
    for (const r of rosterData) {
      pickCapital.set(r.roster_id, []);
    }
    const makePick = (year: number, round: number, originalOwner: number, currentOwner: number): DraftPick => {
      const projectedSlotPct = slotPctByRoster.get(originalOwner) ?? 0.5;
      const estimatedValue = pickLookup
        ? valuePick(pickLookup, year, round, { projectedSlotPct, teams: teamCount })
        : round === 1 ? 30 : round === 2 ? 15 : 10;
      return {
        year,
        round,
        originalOwner: String(originalOwner),
        currentOwner: String(currentOwner),
        estimatedValue,
      };
    };

    // Apply traded picks: build an ownership override keyed by year-round-original.
    const tradedOwner = new Map<string, number>();
    for (const tp of tradedPicks || []) {
      const year = parseInt(tp.season);
      if (!futureYears.includes(year)) continue;
      // owner_id / roster_id are roster ids in traded_picks
      tradedOwner.set(`${year}-${tp.round}-${tp.roster_id}`, tp.owner_id);
    }

    for (const year of futureYears) {
      for (let round = 1; round <= draftRounds; round++) {
        for (const r of rosterData) {
          const originalOwner = r.roster_id;
          const overrideOwner = tradedOwner.get(`${year}-${round}-${originalOwner}`);
          const currentOwner = overrideOwner ?? originalOwner;
          const pick = makePick(year, round, originalOwner, currentOwner);
          pickCapital.get(currentOwner)?.push(pick);
        }
      }
    }
    // Sort each team's picks by year then round.
    for (const picks of pickCapital.values()) {
      picks.sort((a, b) => a.year - b.year || a.round - b.round);
    }

    const rosters: TeamRoster[] = rosterData.map((r: any) => {
      const owner = userMap.get(r.owner_id);
      const rosterPlayers: Player[] = (r.players || [])
        .filter((pid: string) => players[pid])
        .map((pid: string) => players[pid]);

      return {
        teamId: String(r.roster_id),
        teamName: owner?.metadata?.team_name || owner?.display_name || `Team ${r.roster_id}`,
        ownerName: owner?.display_name || owner?.username || "Unknown",
        players: rosterPlayers,
        draftPicks: pickCapital.get(r.roster_id) || [],
      };
    });

    // Find user's team
    const myRoster = rosterData.find((r: any) => r.owner_id === user.user_id);
    const myTeamId = myRoster ? String(myRoster.roster_id) : rosters[0]?.teamId || "";

    // Build roster name map for trade analysis
    const rosterNames = new Map<string, string>();
    for (const r of rosterData) {
      const owner = userMap.get(r.owner_id);
      rosterNames.set(String(r.roster_id), owner?.metadata?.team_name || owner?.display_name || `Team ${r.roster_id}`);
    }

    console.log("Starting historical trade analysis...");
    // Analyze historical trades
    const tradeAnalysis = await analyzeHistoricalTrades(leagueId, players, rosterNames);
    console.log("Trade analysis complete:", JSON.stringify(tradeAnalysis, null, 2));

    return Response.json({
      leagueSettings,
      rosters,
      players,
      myTeamId,
      tradeAnalysis,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
