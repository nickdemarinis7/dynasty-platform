import { getSleeperTransactions, getSleeperLeagueInfo, type SleeperTransaction } from "./sleeper-api";
import type { Player } from "@/types";

export interface TradePattern {
  positionSwap: string; // e.g., "RB->WR", "QB->TE"
  avgValueDiff: number;
  count: number;
  avgAgeDiff: number;
  confidence: number; // 0-1 based on sample size
}

export interface TeamTradingStyle {
  teamId: string;
  teamName: string;
  totalTrades: number;
  preferredPositionsToAcquire: string[];
  preferredPositionsToTradeAway: string[];
  avgValueSent: number;
  avgValueReceived: number;
  winNowTendency: number; // -1 to 1, higher = more win-now trades
  wins: number;
  losses: number;
  ties: number;
}

export interface HistoricalTradeAnalysis {
  patterns: TradePattern[];
  teamStyles: Record<string, TeamTradingStyle>;
  avgValueDiffForAcceptedTrades: number;
  mostCommonTradeTypes: string[];
}

const analysisCache = new Map<string, { expiresAt: number; value: HistoricalTradeAnalysis }>();
const ANALYSIS_CACHE_TTL_MS = 15 * 60 * 1000;

function emptyAnalysis(): HistoricalTradeAnalysis {
  return { patterns: [], teamStyles: {}, avgValueDiffForAcceptedTrades: 0, mostCommonTradeTypes: [] };
}

/**
 * Analyzes historical transactions to extract trade patterns and team tendencies.
 * This helps predict what trades are likely to be accepted.
 */
export async function analyzeHistoricalTrades(
  leagueId: string,
  players: Record<string, Player>,
  rosterNames: Map<string, string>
): Promise<HistoricalTradeAnalysis> {
  const cached = analysisCache.get(leagueId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    // Walk through league history using previous_league_id chain
    const allTransactions: SleeperTransaction[] = [];
    let currentLeagueId: string | null = leagueId;
    const maxSeasons = 5; // Limit to 5 seasons to avoid excessive API calls
    let seasonCount = 0;

    while (currentLeagueId && seasonCount < maxSeasons) {
      try {
        const leagueInfo = await getSleeperLeagueInfo(currentLeagueId);
        // Fetch transactions for each week (1-18) of this season
        const weeklyTransactions: SleeperTransaction[][] = [];
        const weeks = Array.from({ length: 18 }, (_, week) => week + 1);
        // Limit upstream concurrency to avoid bursty imports and Sleeper throttling.
        for (let index = 0; index < weeks.length; index += 6) {
          const batch = weeks.slice(index, index + 6);
          weeklyTransactions.push(...await Promise.all(
            batch.map((week) => getSleeperTransactions(currentLeagueId!, week))
          ));
        }
        const seasonTransactions = weeklyTransactions.flat();
        
        allTransactions.push(...seasonTransactions);
        
        // Move to previous season
        currentLeagueId = leagueInfo.previous_league_id;
        seasonCount++;
      } catch {
        break;
      }
    }
    
    if (allTransactions.length === 0) {
      const result = emptyAnalysis();
      analysisCache.set(leagueId, { expiresAt: Date.now() + ANALYSIS_CACHE_TTL_MS, value: result });
      return result;
    }
    
    // Filter for trades using type: "trade" as per Sleeper API documentation
    const trades = allTransactions.filter(
      (t: SleeperTransaction) => 
        t.type === "trade" &&
        t.status === "complete" &&
        t.roster_ids.length === 2 && // 2 teams involved
        t.adds && // Ensure adds exists
        (Object.keys(t.adds).length > 0 || (t.draft_picks?.length ?? 0) > 0)
    );


    const patterns: Record<string, { valueDiffs: number[]; ageDiffs: number[] }> = {};
    const allTradeValueDiffs: number[] = []; // Track actual value diff for each trade
    const teamStyles: Record<string, {
      totalTrades: number;
      positionsAcquired: string[];
      positionsTradedAway: string[];
      valueSent: number[];
      valueReceived: number[];
      agesReceived: number[];
      wins: number;
      losses: number;
      ties: number;
    }> = {};

    for (const trade of trades) {
      const [rosterA, rosterB] = trade.roster_ids;
      const teamAId = String(rosterA);
      const teamBId = String(rosterB);

      // Initialize team data if needed
      for (const teamId of [teamAId, teamBId]) {
        if (!teamStyles[teamId]) {
          teamStyles[teamId] = {
            totalTrades: 0,
            positionsAcquired: [],
            positionsTradedAway: [],
            valueSent: [],
            valueReceived: [],
            agesReceived: [],
            wins: 0,
            losses: 0,
            ties: 0,
          };
        }
      }

      // Analyze players traded
      const playersA = Object.entries(trade.adds).filter((entry) => entry[1] === rosterA).map(([pid]) => players[pid]);
      const playersB = Object.entries(trade.adds).filter((entry) => entry[1] === rosterB).map(([pid]) => players[pid]);

      const pickValue = (round: number) => round === 1 ? 30 : round === 2 ? 15 : round === 3 ? 10 : 6;
      const pickValueA = (trade.draft_picks || [])
        .filter((pick) => pick.owner_id === rosterA)
        .reduce((sum, pick) => sum + pickValue(pick.round), 0);
      const pickValueB = (trade.draft_picks || [])
        .filter((pick) => pick.owner_id === rosterB)
        .reduce((sum, pick) => sum + pickValue(pick.round), 0);

      // Calculate value differences
      const valueA = playersA.reduce((sum, p) => sum + (p?.dynastyValue || 0), 0) + pickValueA;
      const valueB = playersB.reduce((sum, p) => sum + (p?.dynastyValue || 0), 0) + pickValueB;
      const valueDiff = valueB - valueA;
      allTradeValueDiffs.push(valueDiff); // Track for overall average

      // Track win/loss for each team (based on value at time of trade)
      // A win means you received more value than you sent
      const threshold = 5; // Value diff threshold for tie
      if (Math.abs(valueDiff) < threshold) {
        teamStyles[teamAId]!.ties++;
        teamStyles[teamBId]!.ties++;
      } else if (valueDiff > 0) {
        // Team B received more value (positive valueDiff = valueB - valueA)
        teamStyles[teamBId]!.wins++;
        teamStyles[teamAId]!.losses++;
      } else {
        teamStyles[teamAId]!.wins++;
        teamStyles[teamBId]!.losses++;
      }

      // Calculate age differences
      const avgAgeA = playersA.length > 0 ? playersA.reduce((sum, p) => sum + (p?.age || 0), 0) / playersA.length : 0;
      const avgAgeB = playersB.length > 0 ? playersB.reduce((sum, p) => sum + (p?.age || 0), 0) / playersB.length : 0;
      const ageDiff = avgAgeB - avgAgeA;

      // Track position swap patterns
      if (playersA.length > 0 && playersB.length > 0) {
        const posA = playersA[0]?.position;
        const posB = playersB[0]?.position;
        if (posA && posB && posA !== posB) {
          const swapKey = `${posA}->${posB}`;
          if (!patterns[swapKey]) {
            patterns[swapKey] = { valueDiffs: [], ageDiffs: [] };
          }
          patterns[swapKey].valueDiffs.push(valueDiff);
          patterns[swapKey].ageDiffs.push(ageDiff);
        }
      }

      // Track team-specific patterns
      const styleA = teamStyles[teamAId]!;
      const styleB = teamStyles[teamBId]!;

      styleA.totalTrades++;
      styleB.totalTrades++;

      // Sleeper's `adds` map points to the roster receiving each player.
      styleA.positionsAcquired.push(...playersA.map(p => p?.position || "UNK"));
      styleA.positionsTradedAway.push(...playersB.map(p => p?.position || "UNK"));
      styleA.valueReceived.push(valueA);
      styleA.valueSent.push(valueB);
      styleA.agesReceived.push(...playersA.map(p => p?.age || 0));

      styleB.positionsAcquired.push(...playersB.map(p => p?.position || "UNK"));
      styleB.positionsTradedAway.push(...playersA.map(p => p?.position || "UNK"));
      styleB.valueReceived.push(valueB);
      styleB.valueSent.push(valueA);
      styleB.agesReceived.push(...playersB.map(p => p?.age || 0));
    }

    // Convert patterns to final format
    const patternArray: TradePattern[] = Object.entries(patterns).map(([swapKey, data]) => {
      const count = data.valueDiffs.length;
      // Confidence based on sample size: 1+ trades = 0.3, 3+ trades = 0.6, 5+ trades = 0.9
      const confidence = count >= 5 ? 0.9 : count >= 3 ? 0.6 : count >= 1 ? 0.3 : 0;
      return {
        positionSwap: swapKey,
        avgValueDiff: data.valueDiffs.reduce((a, b) => a + b, 0) / data.valueDiffs.length,
        count,
        avgAgeDiff: data.ageDiffs.reduce((a, b) => a + b, 0) / data.ageDiffs.length,
        confidence,
      };
    }).sort((a, b) => b.count - a.count);

    // Convert team styles to final format
    const teamStyleMap: Record<string, TeamTradingStyle> = {};
    for (const [teamId, data] of Object.entries(teamStyles)) {
      const avgValueSent = data.valueSent.length > 0 ? data.valueSent.reduce((a: number, b: number) => a + b, 0) / data.valueSent.length : 0;
      const avgValueReceived = data.valueReceived.length > 0 ? data.valueReceived.reduce((a: number, b: number) => a + b, 0) / data.valueReceived.length : 0;
      const avgAgeReceived = data.agesReceived.length > 0 ? data.agesReceived.reduce((a: number, b: number) => a + b, 0) / data.agesReceived.length : 0;

      // Count position preferences
      const posCount: Record<string, number> = {};
      data.positionsAcquired.forEach((pos: string) => posCount[pos] = (posCount[pos] || 0) + 1);
      const preferredPositionsToAcquire = Object.entries(posCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([pos]) => pos);

      const posCountTraded: Record<string, number> = {};
      data.positionsTradedAway.forEach((pos: string) => posCountTraded[pos] = (posCountTraded[pos] || 0) + 1);
      const preferredPositionsToTradeAway = Object.entries(posCountTraded)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([pos]) => pos);

      // Win-now tendency: negative if they trade for younger players, positive if older
      const winNowTendency = avgAgeReceived > 28 ? 0.5 : avgAgeReceived < 25 ? -0.5 : 0;

      teamStyleMap[teamId] = {
        teamId,
        teamName: rosterNames.get(teamId) || `Team ${teamId}`,
        totalTrades: data.totalTrades,
        preferredPositionsToAcquire,
        preferredPositionsToTradeAway,
        avgValueSent,
        avgValueReceived,
        winNowTendency,
        wins: data.wins,
        losses: data.losses,
        ties: data.ties,
      };
    }

    // Calculate overall stats using actual trade value diffs (not pattern averages)
    const avgValueDiffForAcceptedTrades = allTradeValueDiffs.length > 0 
      ? allTradeValueDiffs.reduce((a, b) => a + b, 0) / allTradeValueDiffs.length 
      : 0;

    const mostCommonTradeTypes = patternArray.slice(0, 5).map(p => p.positionSwap);

    const result = {
      patterns: patternArray,
      teamStyles: teamStyleMap,
      avgValueDiffForAcceptedTrades,
      mostCommonTradeTypes,
    };
    analysisCache.set(leagueId, { expiresAt: Date.now() + ANALYSIS_CACHE_TTL_MS, value: result });
    return result;
  } catch (error) {
    console.error("Failed to analyze historical trades:", error);
    return emptyAnalysis();
  }
}
