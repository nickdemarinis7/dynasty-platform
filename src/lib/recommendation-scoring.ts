/**
 * Recommendation Scoring System
 * 
 * Provides a unified scoring algorithm for trade recommendations that balances:
 * - Value gain/loss
 * - Positional fit
 * - Acceptance likelihood
 * - Window alignment
 * - League context
 */

import type { Player } from "@/types";

export interface ScoringFactors {
  valueGain: number;          // -100 to +100 (normalized value difference)
  positionalFit: number;      // 0-100 (how well it addresses roster needs)
  acceptanceLikelihood: number; // 0-100 (probability opponent accepts)
  windowAlignment: number;    // 0-100 (timeline compatibility)
  urgency: number;            // 0-100 (how critical this trade is)
}

export interface ScoredRecommendation {
  compositeScore: number;     // 0-100 final score
  factors: ScoringFactors;
  explanation: string;        // Human-readable breakdown
}

/**
 * Calculate composite score for a trade recommendation
 * 
 * Weights:
 * - Acceptance likelihood: 30% (most important - trade must be realistic)
 * - Positional fit: 25% (addresses actual roster needs)
 * - Value gain: 20% (getting fair value)
 * - Window alignment: 15% (timeline compatibility)
 * - Urgency: 10% (how critical the need is)
 */
export function scoreRecommendation(factors: ScoringFactors): ScoredRecommendation {
  const weights = {
    acceptanceLikelihood: 0.30,
    positionalFit: 0.25,
    valueGain: 0.20,
    windowAlignment: 0.15,
    urgency: 0.10,
  };

  // Normalize value gain from -100/+100 to 0-100 scale
  // Negative value (losing value) is bad, positive is good
  // -20 or worse = 0, +20 or better = 100, 0 = 50
  const normalizedValueGain = Math.max(0, Math.min(100, 50 + (factors.valueGain * 2.5)));

  const compositeScore = Math.round(
    normalizedValueGain * weights.valueGain +
    factors.positionalFit * weights.positionalFit +
    factors.acceptanceLikelihood * weights.acceptanceLikelihood +
    factors.windowAlignment * weights.windowAlignment +
    factors.urgency * weights.urgency
  );

  const explanation = buildExplanation(factors, weights, normalizedValueGain);

  return {
    compositeScore: Math.max(0, Math.min(100, compositeScore)),
    factors,
    explanation,
  };
}

function buildExplanation(
  factors: ScoringFactors,
  weights: Record<string, number>,
  normalizedValueGain: number
): string {
  const parts: string[] = [];

  // Value assessment
  if (factors.valueGain > 10) {
    parts.push(`✓ Gain ${Math.round(factors.valueGain)} pts value`);
  } else if (factors.valueGain < -10) {
    parts.push(`✗ Lose ${Math.abs(Math.round(factors.valueGain))} pts value`);
  } else {
    parts.push(`≈ Fair value (±${Math.abs(Math.round(factors.valueGain))} pts)`);
  }

  // Positional fit
  if (factors.positionalFit >= 75) {
    parts.push(`✓ Strong positional fit (${Math.round(factors.positionalFit)}%)`);
  } else if (factors.positionalFit >= 50) {
    parts.push(`≈ Moderate fit (${Math.round(factors.positionalFit)}%)`);
  } else {
    parts.push(`✗ Weak fit (${Math.round(factors.positionalFit)}%)`);
  }

  // Acceptance likelihood
  if (factors.acceptanceLikelihood >= 65) {
    parts.push(`✓ Likely accepted (${Math.round(factors.acceptanceLikelihood)}%)`);
  } else if (factors.acceptanceLikelihood >= 45) {
    parts.push(`≈ Possible (${Math.round(factors.acceptanceLikelihood)}%)`);
  } else {
    parts.push(`✗ Unlikely (${Math.round(factors.acceptanceLikelihood)}%)`);
  }

  // Window alignment
  if (factors.windowAlignment >= 70) {
    parts.push(`✓ Timelines align`);
  }

  return parts.join(" • ");
}

/**
 * Calculate positional fit score based on roster needs
 */
export function calculatePositionalFit(
  targetPosition: string,
  myNeeds: Record<string, number>,
  offeredPosition?: string
): number {
  const targetNeed = myNeeds[targetPosition] || 0;
  
  // If we're giving up a position, reduce fit if we need that position too
  if (offeredPosition) {
    const offeredNeed = myNeeds[offeredPosition] || 0;
    // Penalize if we're trading away a needed position
    const penalty = offeredNeed > 30 ? offeredNeed * 0.5 : 0;
    return Math.max(0, Math.min(100, targetNeed - penalty));
  }

  return Math.min(100, targetNeed);
}

/**
 * Calculate window alignment score
 */
export function calculateWindowAlignment(
  myWindow: { winNowWeight: number; windowLabel: string },
  theirWindow: { winNowWeight: number; windowLabel: string },
  tradeType: "buy" | "sell" | "swap"
): number {
  const windowDiff = Math.abs(myWindow.winNowWeight - theirWindow.winNowWeight);
  
  // For buy/sell trades, opposite windows are GOOD (complementary)
  // For swaps, similar windows are GOOD (both competing or both rebuilding)
  if (tradeType === "buy" || tradeType === "sell") {
    // Opposite windows = high score
    // windowDiff 0.0-0.2 (similar) = 30
    // windowDiff 0.5+ (opposite) = 100
    return Math.min(100, 30 + (windowDiff * 140));
  } else {
    // Similar windows = high score
    // windowDiff 0.0-0.2 (similar) = 100
    // windowDiff 0.5+ (opposite) = 30
    return Math.max(30, 100 - (windowDiff * 140));
  }
}

/**
 * Calculate urgency score based on need level and team context
 */
export function calculateUrgency(
  needLevel: number,
  teamRank: number,
  totalTeams: number,
  isDeadZone: boolean = false
): number {
  // Base urgency from need level
  let urgency = needLevel;

  // Boost for teams in playoff contention (top half)
  if (teamRank <= totalTeams / 2) {
    urgency = Math.min(100, urgency * 1.2);
  }

  // Massive boost for dead zone assets (must sell NOW)
  if (isDeadZone) {
    urgency = Math.min(100, urgency + 40);
  }

  return Math.min(100, urgency);
}

/**
 * Determine if a recommendation should be filtered out entirely
 * (too low quality to show even at bottom of list)
 * 
 * Note: Thresholds adjusted for realistic 25% acceptance base (vs old 50% base)
 */
export function shouldFilterOut(scored: ScoredRecommendation): boolean {
  // Filter out if composite score is below 25 (lowered from 35)
  if (scored.compositeScore < 25) return true;

  // Filter out if acceptance likelihood is too low AND value is very negative
  // Lowered from 25% to 15% to account for new base
  if (scored.factors.acceptanceLikelihood < 15 && scored.factors.valueGain < -15) return true;

  // Filter out if positional fit is terrible AND acceptance is very low
  // Lowered from 40% to 25% to account for new base
  if (scored.factors.positionalFit < 20 && scored.factors.acceptanceLikelihood < 25) return true;

  return false;
}
