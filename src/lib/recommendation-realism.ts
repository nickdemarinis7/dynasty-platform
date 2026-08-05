/**
 * Recommendation Realism Utilities
 * 
 * Enhances trade recommendations with real-world factors:
 * - Manager activity tracking
 * - Recent trade history
 * - League trade velocity
 * - Roster space validation
 * - Dynamic pick valuation
 */

import type { 
  ManagerActivity, 
  RecentTrade, 
  LeagueTradeVelocity, 
  TeamRoster,
  DraftPick,
  LeagueSettings
} from "@/types";
import type { TeamContext } from "@/lib/trade-engine";

// ============================================================================
// Manager Activity
// ============================================================================

export function isManagerActive(activity: ManagerActivity): boolean {
  if (!activity.lastLogin) return false;
  
  const daysSinceLogin = (Date.now() - activity.lastLogin) / (1000 * 60 * 60 * 24);
  
  // Inactive if:
  // - Haven't logged in for 30+ days
  // - OR response rate < 20%
  // - OR zero trades in last 90 days
  if (daysSinceLogin > 30) return false;
  if (activity.responseRate < 0.2 && activity.tradesReceived > 5) return false;
  
  return true;
}

export function calculateActivityMultiplier(activity: ManagerActivity): number {
  if (!isManagerActive(activity)) return 0.1;  // 90% penalty for inactive
  
  // Active managers: boost based on trade frequency
  const tradesPerMonth = activity.tradesCompleted / 3;  // assume 3 months of data
  
  if (tradesPerMonth > 3) return 1.3;   // Very active trader
  if (tradesPerMonth > 1.5) return 1.1; // Active trader
  if (tradesPerMonth > 0.5) return 1.0; // Normal
  if (tradesPerMonth > 0) return 0.8;   // Slow trader
  
  return 0.5;  // No trades but logged in recently
}

// ============================================================================
// Recent Trade History
// ============================================================================

export function getRecentAcquisitions(
  teamId: string,
  recentTrades: RecentTrade[],
  daysBack: number = 21
): string[] {
  const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
  const acquisitions: string[] = [];
  
  for (const trade of recentTrades) {
    if (trade.timestamp < cutoff) continue;
    
    // Check if this team received players
    if (trade.teamAId === teamId) {
      acquisitions.push(...trade.teamBPlayers);
    } else if (trade.teamBId === teamId) {
      acquisitions.push(...trade.teamAPlayers);
    }
  }
  
  return acquisitions;
}

export function wasRecentlyAcquired(
  playerId: string,
  teamId: string,
  recentTrades: RecentTrade[],
  daysBack: number = 21
): boolean {
  const acquisitions = getRecentAcquisitions(teamId, recentTrades, daysBack);
  return acquisitions.includes(playerId);
}

export function calculateRecentTradeMultiplier(
  playerId: string,
  teamId: string,
  recentTrades: RecentTrade[]
): number {
  // Check different time windows
  if (wasRecentlyAcquired(playerId, teamId, recentTrades, 7)) return 0.05;   // 1 week: 95% penalty
  if (wasRecentlyAcquired(playerId, teamId, recentTrades, 14)) return 0.15;  // 2 weeks: 85% penalty
  if (wasRecentlyAcquired(playerId, teamId, recentTrades, 21)) return 0.3;   // 3 weeks: 70% penalty
  if (wasRecentlyAcquired(playerId, teamId, recentTrades, 30)) return 0.6;   // 1 month: 40% penalty
  
  return 1.0;  // No penalty
}

// ============================================================================
// League Trade Velocity
// ============================================================================

export function calculateLeagueVelocity(
  recentTrades: RecentTrade[],
  teamCount: number
): LeagueTradeVelocity {
  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
  
  const last30Days = recentTrades.filter(t => t.timestamp >= thirtyDaysAgo);
  const last7Days = recentTrades.filter(t => t.timestamp >= sevenDaysAgo);
  
  const tradesPerWeek = last7Days.length > 0 ? last7Days.length : (last30Days.length / 4.3);
  const tradesLast30Days = last30Days.length;
  const tradesThisSeason = recentTrades.length;
  
  // Calculate average value difference (would need value data)
  const avgValueDiff = 0;  // TODO: calculate from trade values
  
  // Count trades per team
  const teamTradeCount = new Map<string, number>();
  for (const trade of last30Days) {
    teamTradeCount.set(trade.teamAId, (teamTradeCount.get(trade.teamAId) || 0) + 1);
    teamTradeCount.set(trade.teamBId, (teamTradeCount.get(trade.teamBId) || 0) + 1);
  }
  
  const sortedTeams = Array.from(teamTradeCount.entries())
    .sort((a, b) => b[1] - a[1]);
  
  const mostActiveManagers = sortedTeams.slice(0, 3).map(([id]) => id);
  const leastActiveManagers = sortedTeams.slice(-3).map(([id]) => id);
  
  // Determine activity level
  let leagueActivityLevel: LeagueTradeVelocity["leagueActivityLevel"];
  if (tradesPerWeek > 3) leagueActivityLevel = "very_active";
  else if (tradesPerWeek > 1.5) leagueActivityLevel = "active";
  else if (tradesPerWeek > 0.5) leagueActivityLevel = "moderate";
  else if (tradesPerWeek > 0.1) leagueActivityLevel = "slow";
  else leagueActivityLevel = "dead";
  
  return {
    tradesPerWeek,
    tradesLast30Days,
    tradesThisSeason,
    avgValueDiff,
    mostActiveManagers,
    leastActiveManagers,
    leagueActivityLevel,
  };
}

export function adjustAcceptanceForVelocity(
  baseAcceptance: number,
  velocity: LeagueTradeVelocity
): number {
  switch (velocity.leagueActivityLevel) {
    case "very_active":
      return baseAcceptance * 1.3;  // 30% boost
    case "active":
      return baseAcceptance * 1.15; // 15% boost
    case "moderate":
      return baseAcceptance;        // No change
    case "slow":
      return baseAcceptance * 0.7;  // 30% penalty
    case "dead":
      return baseAcceptance * 0.4;  // 60% penalty
  }
}

// ============================================================================
// Roster Space Validation
// ============================================================================

export function hasRosterSpace(
  roster: TeamRoster,
  leagueSettings: LeagueSettings,
  additionalPlayers: number = 1
): boolean {
  const currentSize = roster.players.length;
  // Most dynasty leagues have 25-35 roster spots; default to 30
  const maxSize = 30;
  
  return (currentSize + additionalPlayers - 1) <= maxSize;  // -1 because they're trading someone away
}

export function canAccept2for1(
  roster: TeamRoster,
  leagueSettings: LeagueSettings
): boolean {
  // 2-for-1 means receiving 1 player for 2 players
  // Net change: -1 roster spot
  // So they need at least 1 open spot
  return hasRosterSpace(roster, leagueSettings, 0);  // Just need to not be at max
}

export function canAccept3for2(
  roster: TeamRoster,
  leagueSettings: LeagueSettings
): boolean {
  return hasRosterSpace(roster, leagueSettings, -1);  // Need 1 open spot
}

// ============================================================================
// Dynamic Pick Valuation
// ============================================================================

export function estimatePickPosition(
  team: TeamContext,
  allTeams: TeamContext[]
): number {
  // Use current standings (inverted - worst team = pick 1)
  const totalTeams = allTeams.length;
  return totalTeams - team.leagueRank + 1;
}

export function dynamicPickValue(
  pick: DraftPick,
  ownerTeam: TeamContext,
  allTeams: TeamContext[]
): number {
  const baseValue = pick.estimatedValue;
  
  // Only adjust for current year and next year picks
  const currentYear = new Date().getFullYear();
  if (pick.year > currentYear + 1) return baseValue;  // Too far out to predict
  
  const projectedPick = estimatePickPosition(ownerTeam, allTeams);
  
  // Adjust based on projected pick position
  // Early picks (1-3) are significantly more valuable
  // Late picks (10-12) are less valuable
  let multiplier = 1.0;
  
  if (pick.round === 1) {
    if (projectedPick <= 3) multiplier = 1.5;       // Top 3 pick
    else if (projectedPick <= 6) multiplier = 1.25; // Early 1st
    else if (projectedPick <= 9) multiplier = 1.0;  // Mid 1st
    else multiplier = 0.85;                          // Late 1st
  } else if (pick.round === 2) {
    if (projectedPick <= 3) multiplier = 1.3;       // Early 2nd
    else if (projectedPick <= 6) multiplier = 1.1;
    else multiplier = 0.9;                          // Late 2nd
  }
  
  return Math.round(baseValue * multiplier);
}

// ============================================================================
// Multi-Pick Combinations
// ============================================================================

export interface PickCombination {
  picks: DraftPick[];
  totalValue: number;
  description: string;
}

export function findPickCombinations(
  availablePicks: DraftPick[],
  targetValue: number,
  maxPicks: number = 2,
  tolerance: number = 0.25
): PickCombination[] {
  const combinations: PickCombination[] = [];
  const minValue = targetValue * (1 - tolerance);
  const maxValue = targetValue * (1 + tolerance);
  
  // Single picks
  for (const pick of availablePicks) {
    if (pick.estimatedValue >= minValue && pick.estimatedValue <= maxValue) {
      combinations.push({
        picks: [pick],
        totalValue: pick.estimatedValue,
        description: `${pick.year} R${pick.round}`,
      });
    }
  }
  
  if (maxPicks >= 2) {
    // Two-pick combinations
    for (let i = 0; i < availablePicks.length; i++) {
      for (let j = i + 1; j < availablePicks.length; j++) {
        const combined = availablePicks[i].estimatedValue + availablePicks[j].estimatedValue;
        if (combined >= minValue && combined <= maxValue) {
          combinations.push({
            picks: [availablePicks[i], availablePicks[j]],
            totalValue: combined,
            description: `${availablePicks[i].year} R${availablePicks[i].round} + ${availablePicks[j].year} R${availablePicks[j].round}`,
          });
        }
      }
    }
  }
  
  if (maxPicks >= 3) {
    // Three-pick combinations
    for (let i = 0; i < availablePicks.length; i++) {
      for (let j = i + 1; j < availablePicks.length; j++) {
        for (let k = j + 1; k < availablePicks.length; k++) {
          const combined = availablePicks[i].estimatedValue + availablePicks[j].estimatedValue + availablePicks[k].estimatedValue;
          if (combined >= minValue && combined <= maxValue) {
            combinations.push({
              picks: [availablePicks[i], availablePicks[j], availablePicks[k]],
              totalValue: combined,
              description: `${availablePicks[i].year} R${availablePicks[i].round} + ${availablePicks[j].year} R${availablePicks[j].round} + ${availablePicks[k].year} R${availablePicks[k].round}`,
            });
          }
        }
      }
    }
  }
  
  // Sort by how close to target value
  return combinations.sort((a, b) => {
    const aDiff = Math.abs(a.totalValue - targetValue);
    const bDiff = Math.abs(b.totalValue - targetValue);
    return aDiff - bDiff;
  });
}

// ============================================================================
// Improved Acceptance Calculation
// ============================================================================

export function calculateRealisticAcceptance(
  baseAcceptance: number,
  managerActivity: ManagerActivity | undefined,
  recentTrades: RecentTrade[],
  targetPlayerId: string,
  targetTeamId: string,
  velocity: LeagueTradeVelocity
): number {
  let acceptance = baseAcceptance;
  
  // 1. Manager activity multiplier
  if (managerActivity) {
    const activityMult = calculateActivityMultiplier(managerActivity);
    acceptance *= activityMult;
  } else {
    // No activity data = assume moderate activity
    acceptance *= 0.7;
  }
  
  // 2. Recent trade multiplier
  const recentTradeMult = calculateRecentTradeMultiplier(targetPlayerId, targetTeamId, recentTrades);
  acceptance *= recentTradeMult;
  
  // 3. League velocity adjustment
  acceptance = adjustAcceptanceForVelocity(acceptance, velocity);
  
  // 4. Clamp to realistic range (5-95%)
  return Math.max(5, Math.min(95, acceptance));
}

// ============================================================================
// Injury Adjustments
// ============================================================================

export function adjustValueForInjury(
  baseValue: number,
  injuryStatus?: string,
  weeksMissed?: number
): number {
  if (!injuryStatus || injuryStatus === "active") return baseValue;
  
  switch (injuryStatus) {
    case "questionable":
      return baseValue * 0.95;  // 5% discount
    case "doubtful":
      return baseValue * 0.85;  // 15% discount
    case "out":
      if (weeksMissed && weeksMissed > 6) return baseValue * 0.5;  // Long-term injury
      return baseValue * 0.7;  // 30% discount
    case "ir":
      return baseValue * 0.6;  // 40% discount
    case "suspended":
      return baseValue * 0.7;  // 30% discount
    default:
      return baseValue;
  }
}
