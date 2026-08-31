/**
 * Lineup Optimizer
 * 
 * Simulates optimal starting lineups based on league settings and player projections.
 * Used to evaluate if a trade actually improves your starting lineup.
 */

import type { Player, LeagueSettings, RosterSlot } from "@/types";
import type { PlayerProjection } from "./projections-api";

export interface OptimizedLineup {
  starters: Player[];
  bench: Player[];
  totalProjectedPoints: number;
  positionBreakdown: Record<string, Player[]>;
  flexPlayers: Player[];
}

export interface LineupSlot {
  position: string;
  player: Player | null;
  projectedPoints: number;
}

/**
 * Get projected points for a player
 * 
 * Uses real weekly projections from Sleeper API if available,
 * otherwise falls back to dynasty value as proxy.
 * 
 * @param player - Player to project
 * @param isPlayoffs - Whether this is playoff weeks (15-17)
 * @param currentWeek - Current NFL week (1-18), used for bye week checks
 * @param projections - Optional map of player_id to real projections
 * @param scoringType - Scoring format: "ppr", "half_ppr", "std"
 */
function getProjectedPoints(
  player: Player, 
  isPlayoffs: boolean = false, 
  currentWeek?: number,
  projections?: Record<string, PlayerProjection>,
  scoringType: "ppr" | "half_ppr" | "std" = "half_ppr"
): number {
  // Check if player is on bye this week
  if (currentWeek && player.byeWeek && player.byeWeek === currentWeek) {
    return 0;  // Player on bye - can't play
  }
  
  // Use real projections if available
  if (projections && projections[player.id]) {
    const projection = projections[player.id];
    const pointsField = scoringType === "ppr" ? "pts_ppr" : 
                        scoringType === "half_ppr" ? "pts_half_ppr" : 
                        "pts_std";
    
    // Access stats from nested stats object
    let points = projection.stats?.[pointsField] || 0;
    
    // Apply playoff boost if needed (projections might not have this built in)
    if (isPlayoffs && points > 0) {
      points *= 1.2;
    }
    
    return Math.round(points * 10) / 10;
  }
  
  // Fallback: Dynasty value is 0-100 scale (age + production + future potential).
  // Dynasty value inflates young/developmental players — discount by age factor
  // so a 22yo backup with value 60 doesn't project the same weekly pts as a
  // 28yo starter with value 60 who actually produces more NOW.
  const dynastyVal = player.dynastyValue || 0;
  // Age discount: young players' dynasty value is partly future potential, not current production
  const ageDiscount = player.age <= 22 ? 0.70 : player.age <= 24 ? 0.85 : player.age <= 27 ? 1.0 : player.age <= 30 ? 1.05 : 0.90;
  const adjustedVal = dynastyVal * ageDiscount;
  let basePoints = 0;
  
  switch (player.position) {
    case "QB":
      // QB: value 60 ≈ 18 ppg, value 100 ≈ 26 ppg
      basePoints = 10 + (adjustedVal / 100) * 16;
      break;
    case "RB":
      // RB: value 60 ≈ 13 ppg, value 100 ≈ 20 ppg
      basePoints = 6 + (adjustedVal / 100) * 14;
      break;
    case "WR":
      // WR: value 60 ≈ 12 ppg, value 100 ≈ 18 ppg
      basePoints = 5 + (adjustedVal / 100) * 13;
      break;
    case "TE":
      // TE: value 60 ≈ 9 ppg, value 100 ≈ 14 ppg
      basePoints = 4 + (adjustedVal / 100) * 10;
      break;
    default:
      basePoints = adjustedVal / 10;
  }
  
  // Apply injury/suspension adjustments
  if (player.injuryStatus && player.injuryStatus !== "active") {
    switch (player.injuryStatus.toLowerCase()) {
      case "questionable":
      case "q":
        basePoints *= 0.85;  // 15% reduction (might not play or limited)
        break;
      case "doubtful":
      case "d":
        basePoints *= 0.3;   // 70% reduction (unlikely to play)
        break;
      case "out":
      case "o":
        basePoints = 0;      // Won't play
        break;
      case "ir":
      case "pup":
      case "nfi":
        basePoints = 0;      // Won't play
        break;
      case "suspended":
      case "sus":
        basePoints = 0;      // Won't play
        break;
    }
  }
  
  // Playoff boost (weeks 15-17)
  if (isPlayoffs) {
    basePoints *= 1.2;
  }
  
  return Math.round(basePoints * 10) / 10; // Round to 1 decimal
}

/**
 * Optimize lineup to maximize projected points
 * 
 * @param players - Available players
 * @param leagueSettings - League roster settings
 * @param isPlayoffs - Whether this is playoff weeks (15-17)
 * @param currentWeek - Current NFL week (1-18) for bye week checks
 * @param projections - Optional real weekly projections from Sleeper API
 * @param scoringType - Scoring format: "ppr", "half_ppr", "std"
 */
export function optimizeLineup(
  players: Player[],
  leagueSettings: LeagueSettings,
  isPlayoffs: boolean = false,
  currentWeek?: number,
  projections?: Record<string, PlayerProjection>,
  scoringType: "ppr" | "half_ppr" | "std" = "half_ppr"
): OptimizedLineup {
  const starters: Player[] = [];
  const availablePlayers = [...players].sort((a, b) => 
    getProjectedPoints(b, isPlayoffs, currentWeek, projections, scoringType) - 
    getProjectedPoints(a, isPlayoffs, currentWeek, projections, scoringType)
  );
  
  // Build required slots from roster settings
  const requiredSlots: { position: string; count: number }[] = [];
  
  for (const slot of leagueSettings.rosterSlots) {
    if (slot.type === "BN" || slot.type === "IR") continue; // Skip bench/IR
    
    requiredSlots.push({
      position: slot.type,
      count: slot.count,
    });
  }
  
  // Track filled slots
  const filledSlots = new Map<string, number>();
  requiredSlots.forEach(s => filledSlots.set(s.position, 0));
  
  // First pass: Fill position-specific slots (QB, RB, WR, TE, K, DEF)
  for (const player of availablePlayers) {
    const pos = player.position;
    const slotKey = pos;
    
    if (filledSlots.has(slotKey)) {
      const filled = filledSlots.get(slotKey)!;
      const required = requiredSlots.find(s => s.position === slotKey)?.count || 0;
      
      if (filled < required) {
        starters.push(player);
        filledSlots.set(slotKey, filled + 1);
      }
    }
  }
  
  // Second pass: Fill FLEX slots
  const flexSlot = requiredSlots.find(s => s.position === "FLEX");
  if (flexSlot) {
    const flexEligible = availablePlayers.filter(p => 
      !starters.includes(p) && ["RB", "WR", "TE"].includes(p.position)
    );
    
    for (let i = 0; i < flexSlot.count && i < flexEligible.length; i++) {
      starters.push(flexEligible[i]);
    }
  }
  
  // Third pass: Fill SUPERFLEX slots
  const superflexSlot = requiredSlots.find(s => s.position === "SUPERFLEX");
  if (superflexSlot) {
    const superflexEligible = availablePlayers.filter(p => 
      !starters.includes(p) && ["QB", "RB", "WR", "TE"].includes(p.position)
    );
    
    for (let i = 0; i < superflexSlot.count && i < superflexEligible.length; i++) {
      starters.push(superflexEligible[i]);
    }
  }
  
  // Calculate total projected points
  const totalProjectedPoints = starters.reduce(
    (sum, p) => sum + getProjectedPoints(p, isPlayoffs, currentWeek, projections, scoringType),
    0
  );
  
  // Bench = everyone not starting
  const bench = availablePlayers.filter(p => !starters.includes(p));
  
  // Position breakdown
  const positionBreakdown: Record<string, Player[]> = {};
  for (const player of starters) {
    if (!positionBreakdown[player.position]) {
      positionBreakdown[player.position] = [];
    }
    positionBreakdown[player.position].push(player);
  }
  
  // Identify flex players
  const flexPlayers = starters.filter(p => {
    const posSlot = requiredSlots.find(s => s.position === p.position);
    if (!posSlot) return false;
    
    const posStarters = positionBreakdown[p.position] || [];
    const posIndex = posStarters.indexOf(p);
    
    return posIndex >= posSlot.count; // Beyond required position slots = flex
  });
  
  return {
    starters,
    bench,
    totalProjectedPoints: Math.round(totalProjectedPoints * 10) / 10,
    positionBreakdown,
    flexPlayers,
  };
}

/**
 * Evaluate trade impact on starting lineup
 */
export interface TradeLineupImpact {
  beforePoints: number;
  afterPoints: number;
  pointsGained: number;
  percentGain: number;
  receivedPlayerStarts: boolean;
  receivedPlayerSlot: "starter" | "flex" | "bench";
  givenPlayersWereStarters: boolean[];
  benchDepthBefore: number;
  benchDepthAfter: number;
  recommendation: "strong_upgrade" | "upgrade" | "lateral" | "downgrade" | "strong_downgrade";
  reasoning: string;
}

export function evaluateTradeLineupImpact(
  currentRoster: Player[],
  playersGiven: Player[],
  playersReceived: Player[],
  leagueSettings: LeagueSettings,
  isPlayoffs: boolean = false,
  currentWeek?: number,
  projections?: Record<string, PlayerProjection>,
  scoringType: "ppr" | "half_ppr" | "std" = "half_ppr"
): TradeLineupImpact {
  // Before trade
  const beforeLineup = optimizeLineup(currentRoster, leagueSettings, isPlayoffs, currentWeek, projections, scoringType);
  
  // After trade
  const afterRoster = currentRoster
    .filter(p => !playersGiven.some(gp => gp.id === p.id))
    .concat(playersReceived);
  const afterLineup = optimizeLineup(afterRoster, leagueSettings, isPlayoffs, currentWeek, projections, scoringType);
  
  // Calculate impact
  const pointsGained = afterLineup.totalProjectedPoints - beforeLineup.totalProjectedPoints;
  const percentGain = (pointsGained / beforeLineup.totalProjectedPoints) * 100;
  
  // Check if received player(s) start
  const receivedPlayerStarts = playersReceived.some(p => 
    afterLineup.starters.some(s => s.id === p.id)
  );
  
  // Determine slot for primary received player
  let receivedPlayerSlot: "starter" | "flex" | "bench" = "bench";
  if (playersReceived.length > 0) {
    const primaryReceived = playersReceived[0];
    if (afterLineup.starters.some(s => s.id === primaryReceived.id)) {
      if (afterLineup.flexPlayers.some(f => f.id === primaryReceived.id)) {
        receivedPlayerSlot = "flex";
      } else {
        receivedPlayerSlot = "starter";
      }
    }
  }
  
  // Check if given players were starters
  const givenPlayersWereStarters = playersGiven.map(p =>
    beforeLineup.starters.some(s => s.id === p.id)
  );
  
  // Bench depth
  const benchDepthBefore = beforeLineup.bench.length;
  const benchDepthAfter = afterLineup.bench.length;
  
  // Recommendation
  let recommendation: TradeLineupImpact["recommendation"];
  let reasoning = "";
  
  if (pointsGained >= 5) {
    recommendation = "strong_upgrade";
    reasoning = `Adds ${pointsGained.toFixed(1)} PPG to your starting lineup. Strong upgrade.`;
  } else if (pointsGained >= 2) {
    recommendation = "upgrade";
    reasoning = `Adds ${pointsGained.toFixed(1)} PPG to your starting lineup. Solid upgrade.`;
  } else if (pointsGained >= -1) {
    recommendation = "lateral";
    if (!receivedPlayerStarts) {
      reasoning = "Received player sits on bench. Minimal lineup impact.";
    } else {
      reasoning = `Marginal ${pointsGained >= 0 ? 'gain' : 'loss'} of ${Math.abs(pointsGained).toFixed(1)} PPG.`;
    }
  } else if (pointsGained >= -3) {
    recommendation = "downgrade";
    reasoning = `Loses ${Math.abs(pointsGained).toFixed(1)} PPG from starting lineup. Downgrade.`;
  } else {
    recommendation = "strong_downgrade";
    reasoning = `Loses ${Math.abs(pointsGained).toFixed(1)} PPG from starting lineup. Significant downgrade.`;
  }
  
  // Add context about starters
  if (givenPlayersWereStarters.some(x => x) && !receivedPlayerStarts) {
    reasoning += " Trading away starter(s) for bench player(s).";
  }
  
  return {
    beforePoints: beforeLineup.totalProjectedPoints,
    afterPoints: afterLineup.totalProjectedPoints,
    pointsGained: Math.round(pointsGained * 10) / 10,
    percentGain: Math.round(percentGain * 10) / 10,
    receivedPlayerStarts,
    receivedPlayerSlot,
    givenPlayersWereStarters,
    benchDepthBefore,
    benchDepthAfter,
    recommendation,
    reasoning,
  };
}

/**
 * Get optimal lineup display for UI
 */
export function getLineupDisplay(
  players: Player[],
  leagueSettings: LeagueSettings
): LineupSlot[] {
  const optimized = optimizeLineup(players, leagueSettings);
  const slots: LineupSlot[] = [];
  
  // Build slots from roster settings
  for (const slotConfig of leagueSettings.rosterSlots) {
    if (slotConfig.type === "BN" || slotConfig.type === "IR") continue;
    
    for (let i = 0; i < slotConfig.count; i++) {
      let player: Player | null = null;
      
      if (slotConfig.type === "FLEX") {
        player = optimized.flexPlayers[i] || null;
      } else if (slotConfig.type === "SUPERFLEX") {
        // Get superflex players (after QB slots filled)
        const sfPlayers = optimized.starters.filter(p => 
          optimized.flexPlayers.includes(p) || 
          (p.position === "QB" && optimized.positionBreakdown["QB"]?.indexOf(p) >= 1)
        );
        player = sfPlayers[i] || null;
      } else {
        const posPlayers = optimized.positionBreakdown[slotConfig.type] || [];
        player = posPlayers[i] || null;
      }
      
      slots.push({
        position: slotConfig.type,
        player,
        projectedPoints: player ? getProjectedPoints(player, false, undefined) : 0,
      });
    }
  }
  
  return slots;
}
