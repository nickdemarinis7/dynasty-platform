"use client";

// Normalize any player value to 0-100 scale.
// Values > 150: FantasyCalc 0-10000 — divide by 100 and cap. Values 0-150: already 0-100 — just cap.
const normVal = (v: number): number =>
  v > 150 ? Math.min(100, Math.round(v / 100)) : Math.min(100, v);

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_DYNASTY_VALUES, calculatePositionalNeed } from "@/lib/player-values";
import { buildLeagueContext, getAssetTimeProfile, evaluateTrade } from "@/lib/trade-engine";
import { computeAllProjections } from "@/lib/projections";
import { scoreRecommendation, calculatePositionalFit, calculateWindowAlignment, calculateUrgency, shouldFilterOut, type ScoredRecommendation } from "@/lib/recommendation-scoring";
import { findPickCombinations } from "@/lib/recommendation-realism";
import { getCachedProjections, getCurrentNFLWeek } from "@/lib/projections-cache";
import type { Player, PlayerProjection, RosterSlot } from "@/types";
import type { PlayerProjection as SleeperProjection } from "@/lib/projections-api";
import {
  Lightbulb,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Target,
  AlertCircle,
  ThumbsUp,
  ThumbsDown,
  ArrowRightLeft,
  Zap,
  Filter,
} from "lucide-react";

const positionColors: Record<string, string> = {
  QB: "text-red-400 border-red-500/30",
  RB: "text-green-400 border-green-500/30",
  WR: "text-blue-400 border-blue-500/30",
  TE: "text-orange-400 border-orange-500/30",
};

type TradeType = "buy" | "sell" | "upgrade" | "2for1" | "buy-low" | "pick";
type FilterType = "all" | "buy" | "sell" | "QB" | "RB" | "WR" | "TE";

interface TradeIdea {
  type: TradeType;
  targetPlayer: Player;
  targetTeamId: string;
  targetTeamName: string;
  offeredPlayers: Player[];
  offeredPicks?: { year: number; round: number; estimatedValue: number }[];
  receivingPicks?: { year: number; round: number; estimatedValue: number }[];
  valueDiff: number;
  reason: string;
  priority: "high" | "medium" | "low";
  acceptanceLikelihood: number;
  verdictTone: "good" | "fair" | "bad";
  tradeOptions?: Array<{ 
    offerPlayer: Player; 
    offerValue: number; 
    diff: number; 
    acceptance: number; 
    verdictTone: "good" | "fair" | "bad"; 
    reason: string; 
    evalResult?: {
      lineupImpactA?: {
        pointsGained: number;
        receivedPlayerStarts: boolean;
        recommendation: "strong_upgrade" | "upgrade" | "lateral" | "downgrade" | "strong_downgrade";
      };
    };
  }>;
  roadmap?: string[];
  // New scoring fields
  compositeScore?: number;
  scoreExplanation?: string;
  // Lineup impact from trade evaluation
  evalResult?: {
    lineupImpactA?: {
      pointsGained: number;
      receivedPlayerStarts: boolean;
      recommendation: "strong_upgrade" | "upgrade" | "lateral" | "downgrade" | "strong_downgrade";
    };
  };
}

const typeConfig: Record<TradeType, { label: string; color: string; bg: string }> = {
  buy: { label: "BUY", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/30" },
  sell: { label: "SELL HIGH", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/30" },
  upgrade: { label: "UPGRADE", color: "text-green-400", bg: "bg-green-500/10 border-green-500/30" },
  "2for1": { label: "2-FOR-1", color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/30" },
  pick: { label: "PICK TRADE", color: "text-cyan-400", bg: "bg-cyan-500/10 border-cyan-500/30" },
  "buy-low": { label: "BUY LOW", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/30" },
};

interface PlanStep {
  phase: number;
  type: "buy" | "sell" | "hold";
  trade?: TradeIdea;
  headline: string;
  context: string;
  needsBefore: Record<string, number>;
  needsAfter?: Record<string, number>;
}

interface StrategicPlan {
  teamSummary: {
    window: string;
    windowColor: string;
    rank: number;
    avgAge: number;
    strengths: string[];
    weaknesses: string[];
    positionRanks: Record<string, number>;                  // league rank per position (1 = best)
    dynastyPowerScore: number;                             // 0-100 composite dynasty trajectory
    pickSurplusLabel: "surplus" | "normal" | "deficit";    // pick capital vs league avg
    pickCapital: number;                                   // total estimated pick value
    totalTeams: number;
  };
  windowStrategy: string;
  steps: PlanStep[];
}

function acceptColor(pct: number) {
  if (pct >= 65) return "bg-green-500";
  if (pct >= 45) return "bg-yellow-500";
  return "bg-orange-500";
}

function acceptLabel(pct: number) {
  if (pct >= 65) return "text-green-400";
  if (pct >= 45) return "text-yellow-400";
  return "text-orange-400";
}

export default function RecommendationsPage() {
  const router = useRouter();
  const { rosters, myTeamId, personalValues, leagueSettings, addTradeFeedback, tradeAnalysis, playerStats } = useAppStore();
  const [filter, setFilter] = useState<FilterType>("all");
  const [minAcceptance, setMinAcceptance] = useState(0);
  const [minScore, setMinScore] = useState(0);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [sleeperProjections, setSleeperProjections] = useState<Record<string, SleeperProjection>>({});
  const [projectionsLoading, setProjectionsLoading] = useState(true);
  const [currentWeek, setCurrentWeek] = useState<{ season: number; week: number; isPlayoffs: boolean } | null>(null);

  const myRoster = rosters.find((r) => r.teamId === myTeamId);
  
  // Fetch Sleeper projections on mount
  useEffect(() => {
    async function fetchProjections() {
      try {
        setProjectionsLoading(true);
        const nflWeek = getCurrentNFLWeek();
        setCurrentWeek(nflWeek);
        
        const projs = await getCachedProjections(nflWeek.season, nflWeek.week);
        setSleeperProjections(projs);
        console.log(`[Recommendations] Loaded ${Object.keys(projs).length} player projections for ${nflWeek.season} Week ${nflWeek.week}`);
      } catch (error) {
        console.error("[Recommendations] Failed to fetch projections:", error);
      } finally {
        setProjectionsLoading(false);
      }
    }
    
    fetchProjections();
  }, []);

  const getPlayerValue = (player: Player): number => {
    const raw = personalValues[player.id] ?? player.dynastyValue ?? DEFAULT_DYNASTY_VALUES[player.name] ?? 10;
    return normVal(raw);
  };

  // Proprietary projections (Tier 1 always available; Tier 2+3 after stats load)
  const projections = useMemo((): Record<string, PlayerProjection> => {
    if (!leagueSettings || rosters.length === 0) return {};
    return computeAllProjections(rosters.flatMap((r) => r.players), leagueSettings, playerStats);
  }, [rosters, leagueSettings, playerStats]);

  // Projection-adjusted values on a 0-100 scale.
  // Base = normalized market value (FantasyCalc ÷0 or DEFAULT fallback).
  // Edge adjustment: +1pt per 2.5 edge score above 50, −1pt per 2.5 below 50 (max ±20 pts).
  // This replaces the broken multiplier approach which capped boosts at ×1.25 and
  // produced nonsense ratios for rookies with near-zero market scores.
  const projAdjValues = useMemo((): Record<string, number> => {
    const playerById: Record<string, Player> = {};
    for (const r of rosters) for (const p of r.players) playerById[p.id] = p;
    const result: Record<string, number> = {};
    for (const [id, proj] of Object.entries(projections)) {
      const player = playerById[id];
      if (!player) continue;
      const rawVal = personalValues[id] ?? player.dynastyValue ?? DEFAULT_DYNASTY_VALUES[player.name] ?? 0;
      const base = normVal(rawVal);
      if (base < 5) continue; // skip noise (no dynastyValue + no override)
      // edgeScore=50 neutral, =100 → +30, =0 → -30 (wider range lets alpha/SF signals matter)
      const edgeAdj = Math.round((proj.edgeScore - 50) * 0.6);
      result[id] = Math.min(100, Math.max(0, base + edgeAdj));
    }
    return result;
  }, [projections, rosters, personalValues]);

  // Inline helper: renders edge delta badge next to a player name
  const getEdgeBadge = (player: Player) => {
    const proj = projections[player.id];
    // Suppress badge for low-value players — edgeDelta is unreliable near zero market value
    if (!proj || Math.abs(proj.edgeDelta) < 5 || (player.dynastyValue || 0) < 5) return null;
    const pos = proj.edgeDelta > 0;
    return (
      <span className={`text-xs font-bold ml-0.5 ${pos ? "text-green-400" : "text-red-400"}`}>
        {pos ? "↑" : "↓"}{Math.abs(proj.edgeDelta)}
      </span>
    );
  };

  const handleFeedback = (idea: TradeIdea, reaction: "thumbs_up" | "thumbs_down" | "dismissed") => {
    addTradeFeedback({
      id: `${idea.targetPlayer.id}-${Date.now()}`,
      timestamp: Date.now(),
      targetPlayerId: idea.targetPlayer.id,
      targetPosition: idea.targetPlayer.position,
      offeredPlayerIds: idea.offeredPlayers.map((p) => p.id),
      offeredPositions: idea.offeredPlayers.map((p) => p.position),
      reaction,
      reason: idea.reason,
      priority: idea.priority,
    });
  };

  const handleViewInSimulator = (idea: TradeIdea) => {
    if (!myTeamId) return;
    const params = new URLSearchParams();
    params.set("teamA", myTeamId);
    params.set("teamB", idea.targetTeamId);

    if (idea.type === "sell") {
      if (idea.receivingPicks && idea.receivingPicks.length > 0) {
        // Selling targetPlayer for picks
        params.set("playersA", idea.targetPlayer.id);
      } else if (idea.offeredPlayers.length > 0) {
        // Selling offeredPlayers[0] for targetPlayer
        params.set("playersA", idea.offeredPlayers.map((p) => p.id).join(","));
        params.set("playersB", idea.targetPlayer.id);
      }
    } else {
      params.set("playersA", idea.offeredPlayers.map((p) => p.id).join(","));
      params.set("playersB", idea.targetPlayer.id);
    }

    if (idea.offeredPicks && idea.offeredPicks.length > 0) {
      params.set("picksA", idea.offeredPicks.map((p) => `${p.year}-${p.round}`).join(","));
    }

    router.push(`/trade?${params.toString()}`);
  };

  const generateTradeRoadmap = (
    currentPlayers: Player[],
    targetPlayer: Player,
    offeredPlayer: Player,
    rosterSlots: RosterSlot[],
    superflex: boolean,
    pValues: Record<string, number>
  ): string[] => {
    const roadmap: string[] = [];
    const postTradePlayers = currentPlayers.filter((p) => p.id !== offeredPlayer.id);
    postTradePlayers.push(targetPlayer);

    const postTradeNeeds = calculatePositionalNeed(postTradePlayers, rosterSlots, superflex, pValues);
    const targetPos = targetPlayer.position;
    const filteredNeeds = Object.entries(postTradeNeeds)
      .filter(([pos]) => pos !== targetPos)
      .sort(([, a], [, b]) => b - a);
    const highestNeedPos = filteredNeeds[0];

    if (highestNeedPos && highestNeedPos[1] > 40) {
      const [pos, need] = highestNeedPos;
      roadmap.push(`Next: Target ${pos} to address ${need.toFixed(0)}% need`);

      const availableTargets: Array<{ player: Player; teamName: string; value: number; rosterNeed: number; offerPlayer?: Player }> = [];
      rosters.forEach((roster) => {
        if (roster.teamId === myTeamId) return;
        const theirNeed = calculatePositionalNeed(roster.players, rosterSlots, superflex, pValues)[pos] || 0;
        if (theirNeed < 50) {
          roster.players.forEach((player) => {
            if (player.position === pos) {
              const value = getPlayerValue(player);
              // Normalise to 0-100 for threshold comparisons regardless of whether
              // values come from FantasyCalc (0-10000) or DEFAULT_DYNASTY_VALUES (0-100)
              const normV = (v: number) => (v > 150 ? v / 100 : v);
              const normValue = normV(value);
              if (normValue > 20 && normValue < 75) {
                const mySurplus = postTradePlayers.filter((p) => {
                  const pValue = getPlayerValue(p);
                  const pNorm = normV(pValue);
                  const vNorm = normValue;
                  return Math.abs(pNorm - vNorm) < vNorm * 0.2 && p.id !== targetPlayer.id && pNorm <= vNorm + 5;
                });
                const bestOffer = mySurplus.length > 0
                  ? mySurplus.sort((a, b) => Math.abs(getPlayerValue(a) - value) - Math.abs(getPlayerValue(b) - value))[0]
                  : undefined;
                if (bestOffer) {
                  availableTargets.push({ player, teamName: roster.teamName, value, rosterNeed: theirNeed, offerPlayer: bestOffer });
                }
              }
            }
          });
        }
      });

      availableTargets.sort((a, b) => b.value - a.value || a.rosterNeed - b.rosterNeed);
      availableTargets.slice(0, 2).forEach((target) => {
        if (target.offerPlayer) {
          roadmap.push(`Consider: ${target.player.name} (${target.teamName}) — send ${target.offerPlayer.name} for ${target.player.name}`);
        }
      });
    }

    Object.entries(postTradeNeeds).forEach(([pos, need]) => {
      if (need < 10) roadmap.push(`Surplus ${pos} can be converted to upgrade other positions`);
    });

    const avgAge = postTradePlayers.reduce((sum, p) => sum + p.age, 0) / postTradePlayers.length;
    if (avgAge < 26) roadmap.push(`Team stays young (${avgAge.toFixed(1)} avg age) — keep accumulating future assets`);
    else if (avgAge > 30) roadmap.push(`Team is aging (${avgAge.toFixed(1)} avg age) — prioritize win-now moves`);

    return roadmap.slice(0, 5);
  };

  const recommendations = useMemo((): TradeIdea[] => {
    if (!myRoster || !leagueSettings || rosters.length === 0) return [];

    // Merge projection-adjusted values (0-100) with user overrides (normalized to 0-100).
    // Personal overrides always win; projection adjustments fill in the rest.
    const effectivePValues: Record<string, number> = {
      ...projAdjValues,
      ...Object.fromEntries(Object.entries(personalValues).map(([id, v]) => [id, normVal(v)])),
    };

    const ideas: TradeIdea[] = [];
    // Use projection-adjusted values for all context — ensures needs + acceptance use same value basis
    const leagueCtx = buildLeagueContext(rosters, leagueSettings, effectivePValues);
    const myCtx = myTeamId ? leagueCtx.get(myTeamId) : undefined;
    if (!myCtx) return [];

    const myNeeds = calculatePositionalNeed(myRoster.players, leagueSettings.rosterSlots, leagueSettings.superflex, effectivePValues);

    const getPosMultiplier = (pos: string): number => {
      if (leagueSettings.tePremium && pos === "TE") return 1.3;
      if (leagueSettings.superflex && pos === "QB") return 1.2;
      return 1.0;
    };

    const needPriority = Object.entries(myNeeds).sort(([, a], [, b]) => b - a).filter(([, need]) => need > 20);

    const myPlayersByPos: Record<string, Player[]> = { QB: [], RB: [], WR: [], TE: [] };
    for (const p of myRoster.players) {
      if (myPlayersByPos[p.position]) myPlayersByPos[p.position].push(p);
    }
    for (const pos of Object.keys(myPlayersByPos)) {
      myPlayersByPos[pos].sort((a, b) => getPlayerValue(a) - getPlayerValue(b));
    }

    // Minimum players that must remain at each position AFTER offering someone.
    // In SF you need 2 QBs to fill the QB + SUPERFLEX slots simultaneously.
    const posMinDepth: Record<string, number> = {
      QB: leagueSettings.superflex ? 2 : 1,
      RB: 2, WR: 2, TE: 1,
    };

    // ===== BUY / UPGRADE with window alignment =====
    for (const [neededPos, needLevel] of needPriority) {
      for (const otherRoster of rosters) {
        if (otherRoster.teamId === myTeamId) continue;
        const otherCtx = leagueCtx.get(otherRoster.teamId);
        if (!otherCtx) continue;

        // Window alignment: opposite windows = more likely to make complementary trades
        const windowDiff = Math.abs(myCtx.winNowWeight - otherCtx.winNowWeight);
        const windowAligned = windowDiff > 0.25;
        // Thresholds lowered for 25% acceptance base (was 35/40)
        const adjustedAcceptThreshold = windowAligned ? 15 : 20;

        const theirPlayers = otherRoster.players.filter((p) => p.position === neededPos).sort((a, b) => getPlayerValue(b) - getPlayerValue(a));
        const theirNeeds = calculatePositionalNeed(otherRoster.players, leagueSettings.rosterSlots, leagueSettings.superflex, personalValues);
        const theirStyle = tradeAnalysis?.teamStyles[otherRoster.teamId];
        const theirPreferredPositions = theirStyle?.preferredPositionsToAcquire || [];

        const theirHighNeedPositions = Object.entries(theirNeeds).filter(([, n]) => n > 15).map(([pos]) => pos);
        const boostedPositions = new Set(theirHighNeedPositions);
        theirPreferredPositions.forEach((pos: string) => boostedPositions.add(pos));

        const targetTradeOptions: Map<string, Array<{ offerPlayer: Player; offerValue: number; diff: number; acceptance: number; verdictTone: "good" | "fair" | "bad"; reason: string }>> = new Map();

        for (const target of theirPlayers.slice(0, 5)) {
          const targetValue = getPlayerValue(target) * getPosMultiplier(target.position);
          if (targetValue < 15) continue;
          // QB pre-multiplier guard: raw value must be ≥30 to be dynasty-relevant in SF
          // (1.2× multiplier can lift a backup QB past threshold — this prevents it)
          if (target.position === "QB" && getPlayerValue(target) < 30) continue;

          // Don't acquire clearly declining players — high age + low future curve
          const targetProfile = getAssetTimeProfile(target.position, target.age);
          if (target.age > 31 && targetProfile.futureFactor < 0.4) continue;

          const options: Array<{ 
            offerPlayer: Player; 
            offerValue: number; 
            diff: number; 
            acceptance: number; 
            verdictTone: "good" | "fair" | "bad"; 
            reason: string;
            evalResult?: any;
          }> = [];

          for (const offerPos of boostedPositions) {
            // Skip same-position swaps — rarely makes sense and creates circular suggestions
            if (offerPos === neededPos) continue;
            const swapKey = `${offerPos}->${neededPos}`;
            const historicalPattern = tradeAnalysis?.patterns.find((p) => p.positionSwap === swapKey);
            const isHistoricallyCommon = historicalPattern && historicalPattern.count >= 2;
            const ourSurplus = myPlayersByPos[offerPos];
            if (!ourSurplus || ourSurplus.length <= 1) continue;

            const expendable = ourSurplus.filter((p) => {
              const offerValue = getPlayerValue(p) * getPosMultiplier(p.position);
              return offerValue >= targetValue * 0.5 && offerValue <= targetValue * 1.5;
            });

            for (const offerPlayer of expendable) {
              // Depth guard: don't offer this player if it would leave the position critically depleted
              const remainAfterOffer = (myPlayersByPos[offerPlayer.position]?.length ?? 0) - 1;
              if (remainAfterOffer < posMinDepth[offerPlayer.position]) continue;
              // Anchor protection: never offer untouchable franchise assets
              if (myCtx.anchorPlayerIds.includes(offerPlayer.id)) continue;

              const offerValue = getPlayerValue(offerPlayer) * getPosMultiplier(offerPlayer.position);
              const diff = offerValue - targetValue;
              if (Math.abs(diff) < targetValue * 0.25) {
                // Raw-value sanity check: projection adjustments can lower a player's effective value
                // (e.g. aging RB with declining curve) and make a lopsided trade look filter-safe.
                // But the market — and our UI — shows raw dynastyValue. Cap raw disadvantage at 20%.
                const rawOffer = normVal(offerPlayer.dynastyValue || DEFAULT_DYNASTY_VALUES[offerPlayer.name] || 0);
                const rawTarget = normVal(target.dynastyValue || DEFAULT_DYNASTY_VALUES[target.name] || 0);
                if (rawOffer > rawTarget * 1.20) continue;
                const evalResult = evaluateTrade({
                  teamACtx: myCtx,
                  teamBCtx: otherCtx,
                  aGivesPlayers: [offerPlayer],
                  aGivesPicks: [],
                  bGivesPlayers: [target],
                  bGivesPicks: [],
                  personalValues: effectivePValues,
                  teamARoster: myRoster.players,
                  teamBRoster: otherRoster.players,
                  leagueSettings,
                });

                // Only surface trades where market fairness isn't strongly against us (> -12%)
                if (evalResult.marketFairness > -12 && evalResult.acceptanceLikelihood > adjustedAcceptThreshold) {
                  const windowNote = windowAligned ? ` Windows align (${myCtx.windowLabel} ↔ ${otherCtx.windowLabel}).` : "";
                  options.push({
                    offerPlayer,
                    offerValue,
                    diff,
                    acceptance: evalResult.acceptanceLikelihood,
                    verdictTone: evalResult.verdictForA.tone,
                    reason: `You need ${neededPos}, they need ${offerPos}.${windowNote} ${evalResult.verdictForA.label}. (${Math.round(evalResult.acceptanceLikelihood)}% accept${isHistoricallyCommon ? `, ${historicalPattern.count} similar trades historically` : ""})`,
                    evalResult,
                  });
                }
              }
            }
          }

          if (options.length > 0) targetTradeOptions.set(target.id, options);
        }

        for (const [targetId, options] of targetTradeOptions) {
          const target = theirPlayers.find((p) => p.id === targetId);
          if (!target) continue;
          options.sort((a, b) => b.acceptance - a.acceptance || Math.abs(a.diff) - Math.abs(b.diff));
          const bestOption = options[0] as typeof options[0] & { evalResult?: any };
          const roadmap = generateTradeRoadmap(myRoster.players, target, bestOption.offerPlayer, leagueSettings.rosterSlots, leagueSettings.superflex, personalValues);

          ideas.push({
            type: "buy",
            targetPlayer: target,
            targetTeamId: otherRoster.teamId,
            targetTeamName: otherRoster.teamName,
            offeredPlayers: [bestOption.offerPlayer],
            valueDiff: bestOption.diff,
            reason: bestOption.reason,
            priority: needLevel > 50 ? "high" : needLevel > 30 ? "medium" : "low",
            acceptanceLikelihood: bestOption.acceptance,
            verdictTone: bestOption.verdictTone,
            tradeOptions: options,
            roadmap,
            evalResult: bestOption.evalResult,
          });
        }

        // Player + pick sweetener trades
        for (const target of theirPlayers.slice(0, 5)) {
          const targetValue = getPlayerValue(target) * getPosMultiplier(target.position);
          if (targetValue < 20) continue;
          if (target.position === "QB" && getPlayerValue(target) < 30) continue;
          // Don't acquire clearly declining players — same guard as main buy loop
          const targetProfilePick = getAssetTimeProfile(target.position, target.age);
          if (target.age > 31 && targetProfilePick.futureFactor < 0.4) continue;
          const myValuablePicks = myRoster.draftPicks.filter((p) => p.estimatedValue >= 15);
          if (myValuablePicks.length === 0) continue;

          for (const offerPos of theirHighNeedPositions) {
            const ourSurplus = myPlayersByPos[offerPos];
            if (!ourSurplus || ourSurplus.length <= 1) continue;
            for (const offerPlayer of ourSurplus.slice(-3)) {
              // Depth guard on sweetener trades too
              const remainAfterOffer = (myPlayersByPos[offerPlayer.position]?.length ?? 0) - 1;
              if (remainAfterOffer < posMinDepth[offerPlayer.position]) continue;

              const offerValue = getPlayerValue(offerPlayer) * getPosMultiplier(offerPlayer.position);
              
              // Find best pick combination to sweeten the deal
              const neededPickValue = targetValue - offerValue;
              if (neededPickValue < 5) continue; // Player alone is close enough
              
              const pickCombos = findPickCombinations(
                myValuablePicks,
                neededPickValue,
                2,  // Max 2 picks as sweetener (player + 2 picks = 3 assets total)
                0.4  // 40% tolerance for sweeteners
              );
              
              if (pickCombos.length > 0) {
                const bestPickCombo = pickCombos[0];
                const combinedValue = offerValue + bestPickCombo.totalValue;
                
                // Pick(s) must be meaningful sweetener: contributes ≥10% of combined offer
                if (bestPickCombo.totalValue / combinedValue < 0.10) continue;
                // Offered player must contribute meaningfully — no garbage-player+pick combos
                if (offerValue < 15 || offerValue / combinedValue < 0.15) continue;
                
                const evalResult = evaluateTrade({ 
                  teamACtx: myCtx, 
                  teamBCtx: otherCtx, 
                  aGivesPlayers: [offerPlayer], 
                  aGivesPicks: bestPickCombo.picks, 
                  bGivesPlayers: [target], 
                  bGivesPicks: [], 
                  personalValues: effectivePValues, 
                  teamARoster: myRoster.players, 
                  teamBRoster: otherRoster.players, 
                  leagueSettings 
                });
                
                // Directional check: don't recommend trades that are significantly against us
                if (evalResult.marketFairness > -10 && evalResult.acceptanceLikelihood > 15) {
                  ideas.push({
                    type: "pick",
                    targetPlayer: target,
                    targetTeamId: otherRoster.teamId,
                    targetTeamName: otherRoster.teamName,
                    offeredPlayers: [offerPlayer],
                    offeredPicks: bestPickCombo.picks.map(p => ({ 
                      year: p.year, 
                      round: p.round, 
                      estimatedValue: p.estimatedValue 
                    })),
                    evalResult,
                    valueDiff: combinedValue - targetValue,
                    reason: `Add ${bestPickCombo.description} to sweeten the deal. (${Math.round(evalResult.acceptanceLikelihood)}% accept)`,
                    priority: needLevel > 50 ? "high" : "medium",
                    acceptanceLikelihood: evalResult.acceptanceLikelihood,
                    verdictTone: evalResult.verdictForA.tone,
                  });
                }
              }
            }
          }
        }

        // 2-for-1 trades
        for (const target of theirPlayers.slice(0, 3)) {
          const targetValue = getPlayerValue(target) * getPosMultiplier(target.position);
          if (targetValue < 30) continue;
          if (target.position === "QB" && getPlayerValue(target) < 30) continue;
          // Don't acquire clearly declining players
          const targetProfile2for1 = getAssetTimeProfile(target.position, target.age);
          if (target.age > 31 && targetProfile2for1.futureFactor < 0.4) continue;
          for (const offerPos of theirHighNeedPositions) {
            const ourSurplus = myPlayersByPos[offerPos];
            // Need 4+ at position: offer 2nd+3rd best, keep your starter (#1) and still have a backup
            if (!ourSurplus || ourSurplus.length < 4) continue;
            for (let i = 1; i < Math.min(ourSurplus.length - 1, 3); i++) {
              for (let j = i + 1; j < Math.min(ourSurplus.length, 4); j++) {
                const p1 = ourSurplus[ourSurplus.length - 1 - i]; // 2nd best (skip #1)
                const p2 = ourSurplus[ourSurplus.length - 1 - j]; // 3rd+ best
                // Depth guard: 2-for-1 removes 2 players — ensure enough remain
                const remainAfter2for1 = (myPlayersByPos[offerPos]?.length ?? 0) - 2;
                if (remainAfter2for1 < posMinDepth[offerPos]) continue;

                const totalOfferValue = (getPlayerValue(p1) + getPlayerValue(p2)) * getPosMultiplier(offerPos);
                const diff = totalOfferValue - targetValue;
                if (diff > 0 && diff < targetValue * 0.3) {
                  const evalResult = evaluateTrade({ teamACtx: myCtx, teamBCtx: otherCtx, aGivesPlayers: [p1, p2], aGivesPicks: [], bGivesPlayers: [target], bGivesPicks: [], personalValues: effectivePValues, teamARoster: myRoster.players, teamBRoster: otherRoster.players, leagueSettings });
                  // Directional check: 2-for-1 inherently costs a little, but cap at -15%
                  // Threshold lowered for 25% acceptance base (was 45)
                  if (evalResult.marketFairness > -15 && evalResult.acceptanceLikelihood > 25) {
                    ideas.push({
                      type: "2for1",
                      targetPlayer: target,
                      targetTeamId: otherRoster.teamId,
                      targetTeamName: otherRoster.teamName,
                      offeredPlayers: [p1, p2],
                      evalResult,
                      valueDiff: diff,
                      reason: `Consolidate depth: ${p1.name} + ${p2.name} → ${target.name}. (${Math.round(evalResult.acceptanceLikelihood)}% accept)`,
                      priority: needLevel > 50 ? "high" : "medium",
                      acceptanceLikelihood: evalResult.acceptanceLikelihood,
                      verdictTone: evalResult.verdictForA.tone,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // ===== UPGRADE: sell depth at a position to upgrade your starter =====
    // The BUY loop skips same-position swaps. This loop specifically surfaces
    // "give your WR2/depth to get a better WR1" style moves.
    for (const upgradePos of (["QB", "RB", "WR", "TE"] as const)) {
      const myAtPos = myPlayersByPos[upgradePos] || []; // ascending sort
      if (myAtPos.length < 2) continue; // need depth to sell

      const myBest = myAtPos[myAtPos.length - 1];
      const myBestValue = getPlayerValue(myBest) * getPosMultiplier(upgradePos);

      for (const otherRoster of rosters) {
        if (otherRoster.teamId === myTeamId) continue;
        const otherCtxUpg = leagueCtx.get(otherRoster.teamId);
        if (!otherCtxUpg) continue;

        const theirAtPos = otherRoster.players
          .filter((p) => p.position === upgradePos)
          .sort((a, b) => getPlayerValue(b) - getPlayerValue(a));

        const theirNeedsUpg = calculatePositionalNeed(otherRoster.players, leagueSettings.rosterSlots, leagueSettings.superflex, effectivePValues);

        for (const target of theirAtPos.slice(0, 2)) {
          const targetValue = getPlayerValue(target) * getPosMultiplier(upgradePos);
          // Must be a genuine upgrade over my current best at this position
          if (targetValue <= myBestValue * 1.15) continue;
          if (targetValue < 30) continue;
          const targetProfileUpg = getAssetTimeProfile(upgradePos, target.age);
          if (target.age > 31 && targetProfileUpg.futureFactor < 0.4) continue;

          // Offer candidates: my least-valuable at same pos, OR surplus at positions they need
          const offerCandidates: Player[] = [];
          if (myAtPos.length > (posMinDepth[upgradePos] ?? 1)) {
            offerCandidates.push(myAtPos[0]); // least valuable same-position depth
          }
          Object.entries(theirNeedsUpg)
            .filter(([pos, n]) => n > 20 && pos !== upgradePos)
            .forEach(([pos]) => {
              const surplus = myPlayersByPos[pos] || [];
              if (surplus.length > (posMinDepth[pos] ?? 1)) {
                offerCandidates.push(surplus[0]); // least valuable at their needed position
              }
            });

          for (const offer of offerCandidates) {
            if (!offer) continue;
            const remainAfterUpg = (myPlayersByPos[offer.position]?.length ?? 0) - 1;
            if (remainAfterUpg < (posMinDepth[offer.position] ?? 1)) continue;

            const offerValue = getPlayerValue(offer) * getPosMultiplier(offer.position);
            if (offerValue < 15) continue;
            // Raw-value sanity: same guard as BUY loop — projection adjustments shouldn't hide a lopsided deal
            const rawOfferUpg = normVal(offer.dynastyValue || DEFAULT_DYNASTY_VALUES[offer.name] || 0);
            const rawTargetUpg = normVal(target.dynastyValue || DEFAULT_DYNASTY_VALUES[target.name] || 0);
            if (rawOfferUpg > rawTargetUpg * 1.20) continue;
            if (Math.abs(offerValue - targetValue) > targetValue * 0.35) continue;

            const evalResult = evaluateTrade({
              teamACtx: myCtx,
              teamBCtx: otherCtxUpg,
              aGivesPlayers: [offer],
              aGivesPicks: [],
              bGivesPlayers: [target],
              bGivesPicks: [],
              personalValues: effectivePValues,
              teamARoster: myRoster.players,
              teamBRoster: otherRoster.players,
              leagueSettings,
            });

            // Threshold lowered for 25% acceptance base (was 40)
            if (evalResult.marketFairness > -15 && evalResult.acceptanceLikelihood > 20) {
              const isSamePos = offer.position === upgradePos;
              ideas.push({
                type: "upgrade",
                targetPlayer: target,
                targetTeamId: otherRoster.teamId,
                targetTeamName: otherRoster.teamName,
                offeredPlayers: [offer],
                evalResult,
                valueDiff: offerValue - targetValue,
                reason: isSamePos
                  ? `Consolidate ${upgradePos} quality: give ${offer.name} (depth) to upgrade your starter to ${target.name}. ${evalResult.verdictForA.label}. (${Math.round(evalResult.acceptanceLikelihood)}% accept)`
                  : `Trade ${offer.position} surplus for a ${upgradePos} quality upgrade. ${evalResult.verdictForA.label}. (${Math.round(evalResult.acceptanceLikelihood)}% accept)`,
                priority: "medium",
                acceptanceLikelihood: evalResult.acceptanceLikelihood,
                verdictTone: evalResult.verdictForA.tone,
              });
            }
          }
        }
      }
    }

    // ===== SELL-HIGH using age/time profiles =====
    for (const myPlayer of myRoster.players) {
      const myValue = getPlayerValue(myPlayer);
      if (myValue < 25) continue;

      // Anchor protection: never recommend selling untouchable franchise assets
      if (myCtx.anchorPlayerIds.includes(myPlayer.id)) continue;

      const profile = getAssetTimeProfile(myPlayer.position, myPlayer.age);
      // Dead zone = highest-priority sell (entered age cliff, still tradeable)
      const isDeadZonePlayer = myCtx.deadZonePlayerIds.includes(myPlayer.id);
      // Sell-high outlier: market hasn't repriced declining trajectory yet
      const proj = projections[myPlayer.id];
      const isMarketOvervaluing = !!(proj && proj.edgeDelta < -8 && proj.trajectoryLabel === "DECLINING");
      // Peak or post-peak with declining future value
      const isSellHighCandidate =
        isDeadZonePlayer ||
        isMarketOvervaluing ||
        (profile.nowFactor >= 1.0 && profile.futureFactor < 0.72) ||
        (myPlayer.age >= 29 && profile.futureFactor < 0.55);
      if (!isSellHighCandidate) continue;

      // Don't sell if we significantly need this position (lowered from 55 → 40)
      const myNeedAtPos = myNeeds[myPlayer.position] || 0;
      if (myNeedAtPos > 40) continue;

      for (const otherRoster of rosters) {
        if (otherRoster.teamId === myTeamId) continue;
        const otherCtx = leagueCtx.get(otherRoster.teamId);
        if (!otherCtx) continue;

        const theyNeedPos = otherCtx.positionNeeds[myPlayer.position] > 25;
        const theyAreActive = otherCtx.winNowWeight >= 0.4;
        // Pick-surplus teams are ideal sell targets — they have capital to give back
        const theyHavePickCapital = otherCtx.pickSurplusLabel === "surplus";
        if (!theyNeedPos && !theyAreActive && !theyHavePickCapital) continue;

        // Option A: sell for a younger player
        const theirYoungAssets = otherRoster.players
          .filter((p) => {
            const pProf = getAssetTimeProfile(p.position, p.age);
            const pVal = getPlayerValue(p);
            return pProf.futureFactor > 1.1 && pVal >= myValue * 0.35 && pVal <= myValue * 1.35;
          })
          .sort((a, b) => getPlayerValue(b) - getPlayerValue(a));

        for (const youngPlayer of theirYoungAssets.slice(0, 2)) {
          const youngValue = getPlayerValue(youngPlayer);
          const diff = youngValue - myValue;
          if (Math.abs(diff) > myValue * 0.45) continue;
          // Raw sanity: projection adjustments can invert marketFairness on sell trades
          // (aging player effective value drops, young player effective value rises).
          // Ensure the raw dynasty value received is at least 70% of what you give.
          const rawSellOffer = normVal(myPlayer.dynastyValue || DEFAULT_DYNASTY_VALUES[myPlayer.name] || 0);
          const rawSellReceive = normVal(youngPlayer.dynastyValue || DEFAULT_DYNASTY_VALUES[youngPlayer.name] || 0);
          if (rawSellReceive < rawSellOffer * 0.70) continue;

          const evalResult = evaluateTrade({
            teamACtx: myCtx,
            teamBCtx: otherCtx,
            aGivesPlayers: [myPlayer],
            aGivesPicks: [],
            bGivesPlayers: [youngPlayer],
            bGivesPicks: [],
            personalValues: effectivePValues,
            teamARoster: myRoster.players,
            teamBRoster: otherRoster.players,
            leagueSettings,
          });

          // Directional: selling for far less value is still a bad trade even for youth
          // Threshold lowered for 25% acceptance base (was 30)
          if (evalResult.acceptanceLikelihood > 15 && evalResult.marketFairness > -20) {
            const sellSignal = isDeadZonePlayer ? "⚠ Dead zone asset — sell NOW before value drops." :
              isMarketOvervaluing ? "Market hasn't priced in the decline yet — ideal sell window." :
              "Future curve declining — sell while still at peak.";
            ideas.push({
              type: "sell",
              targetPlayer: youngPlayer,
              targetTeamId: otherRoster.teamId,
              targetTeamName: otherRoster.teamName,
              offeredPlayers: [myPlayer],
              evalResult,
              valueDiff: diff,
              reason: `Sell-high on ${myPlayer.name} (age ${myPlayer.age}). ${sellSignal} Get younger ${youngPlayer.name} (age ${youngPlayer.age}).`,
              priority: (isDeadZonePlayer || profile.futureFactor < 0.5) ? "high" : "medium",
              acceptanceLikelihood: evalResult.acceptanceLikelihood,
              verdictTone: evalResult.verdictForA.tone,
            });
          }
        }

        // Option B: sell for picks
        const theirValuablePicks = otherRoster.draftPicks
          .filter((p) => p.estimatedValue >= myValue * 0.35)
          .sort((a, b) => b.estimatedValue - a.estimatedValue);

        for (const pick of theirValuablePicks.slice(0, 1)) {
          const diff = pick.estimatedValue - myValue;
          if (Math.abs(diff) > myValue * 0.55) continue;
          // Same raw sanity for pick-based sells
          const rawSellOfferPick = normVal(myPlayer.dynastyValue || DEFAULT_DYNASTY_VALUES[myPlayer.name] || 0);
          if (pick.estimatedValue < rawSellOfferPick * 0.70) continue;

          const evalResult = evaluateTrade({
            teamACtx: myCtx,
            teamBCtx: otherCtx,
            aGivesPlayers: [myPlayer],
            aGivesPicks: [],
            bGivesPlayers: [],
            bGivesPicks: [pick],
            personalValues: effectivePValues,
            teamARoster: myRoster.players,
            teamBRoster: otherRoster.players,
            leagueSettings,
          });

          // Guard: don't sell for a pick that's deeply below player market value
          // Lower threshold for pick-surplus partners — they have capital and are ideal recipients
          // Thresholds lowered for 25% acceptance base (was 20/25)
          const pickSellThreshold = otherCtx.pickSurplusLabel === "surplus" ? 10 : 15;
          if (evalResult.acceptanceLikelihood > pickSellThreshold && evalResult.marketFairness > -25) {
            const pickSellSignal = isDeadZonePlayer ? "⚠ Dead zone — sell for capital NOW." :
              isMarketOvervaluing ? "Market overvaluing — ideal sell window for picks." :
              "Future value curve is declining.";
            const capitalNote = otherCtx.pickSurplusLabel === "surplus" ? ` ${otherRoster.teamName} has pick capital to spend.` : "";
            ideas.push({
              type: "sell",
              targetPlayer: myPlayer,
              targetTeamId: otherRoster.teamId,
              targetTeamName: otherRoster.teamName,
              offeredPlayers: [myPlayer],
              evalResult,
              receivingPicks: [{ year: pick.year, round: pick.round, estimatedValue: pick.estimatedValue }],
              valueDiff: diff,
              reason: `Trade ${myPlayer.name} to ${otherRoster.teamName} for ${pick.year} R${pick.round}.${capitalNote} ${pickSellSignal}`,
              priority: (isDeadZonePlayer || profile.futureFactor < 0.5) ? "high" : "medium",
              acceptanceLikelihood: evalResult.acceptanceLikelihood,
              verdictTone: evalResult.verdictForA.tone,
            });
          }
        }
      }
    }

    // ===== BUY-LOW (personal value overrides) =====
    for (const otherRoster of rosters) {
      if (otherRoster.teamId === myTeamId) continue;
      for (const player of otherRoster.players) {
        const marketVal = normVal(player.dynastyValue || DEFAULT_DYNASTY_VALUES[player.name] || 0); // 0-100
        const personalVal = personalValues[player.id] !== undefined ? normVal(personalValues[player.id]) : undefined;
        // Surface when user's model values a player ≥20% above market and player is meaningful
        if (personalVal && marketVal > 1 && personalVal > marketVal * 1.2 && personalVal > 20) {
          ideas.push({
            type: "buy-low",
            targetPlayer: player,
            targetTeamId: otherRoster.teamId,
            targetTeamName: otherRoster.teamName,
            offeredPlayers: [],
            valueDiff: personalVal - marketVal,
            reason: `You value ${player.name} ${Math.round(((personalVal - marketVal) / marketVal) * 100)}% above market. Buy while others are sleeping on him.`,
            priority: "medium",
            acceptanceLikelihood: 55,
            verdictTone: "fair",
          });
        }
      }
    }

    // ===== PURE PICK TRADES =====
    if (myRoster.draftPicks && myRoster.draftPicks.length > 0) {
      for (const otherRoster of rosters) {
        if (otherRoster.teamId === myTeamId) continue;
        const otherCtxPick = leagueCtx.get(otherRoster.teamId);
        if (!otherCtxPick) continue;
        for (const neededPos of Object.keys(myNeeds)) {
          if (myNeeds[neededPos] < 30) continue;
          const theirPlayers = otherRoster.players.filter((p) => p.position === neededPos).sort((a, b) => getPlayerValue(b) - getPlayerValue(a));
          for (const target of theirPlayers.slice(0, 3)) {
            const targetValue = getPlayerValue(target);
            // Don't offer picks for low-value players — not worth the capital.
            if (targetValue < 30) continue;
            // Don't spend picks on clearly declining veterans — same guard as buy/sweetener loops.
            const targetProfilePure = getAssetTimeProfile(target.position, target.age);
            if (target.age > 31 && targetProfilePure.futureFactor < 0.4) continue;
            // Find best pick combination (1-3 picks) that matches target value
            const pickCombos = findPickCombinations(
              myRoster.draftPicks,
              targetValue,
              3,  // Allow up to 3 picks
              0.35  // 35% tolerance
            );
            
            // Try the best combination (closest to target value)
            if (pickCombos.length > 0) {
              const bestCombo = pickCombos[0];
              const diff = bestCombo.totalValue - targetValue;
              
              const evalResult = evaluateTrade({
                teamACtx: myCtx,
                teamBCtx: otherCtxPick,
                aGivesPlayers: [],
                aGivesPicks: bestCombo.picks,
                bGivesPlayers: [target],
                bGivesPicks: [],
                personalValues: effectivePValues,
                teamARoster: myRoster.players,
                teamBRoster: otherRoster.players,
                leagueSettings,
              });
              
              // Threshold lowered for 25% acceptance base (was 35)
              if (evalResult.marketFairness > -10 && evalResult.acceptanceLikelihood > 15) {
                ideas.push({
                  type: "pick",
                  targetPlayer: target,
                  targetTeamId: otherRoster.teamId,
                  targetTeamName: otherRoster.teamName,
                  offeredPlayers: [],
                  offeredPicks: bestCombo.picks.map(p => ({ 
                    year: p.year, 
                    round: p.round, 
                    estimatedValue: p.estimatedValue 
                  })),
                  evalResult,
                  valueDiff: diff,
                  reason: `Offer ${bestCombo.description} (${bestCombo.totalValue.toFixed(0)} value) for ${target.name}. You need ${neededPos}.`,
                  priority: myNeeds[neededPos] > 50 ? "high" : "medium",
                  acceptanceLikelihood: evalResult.acceptanceLikelihood,
                  verdictTone: evalResult.verdictForA.tone,
                });
              }
            }
          }
        }
      }
    }

    // Filter by lineup impact - remove trades where received player sits on bench
    // This is the #1 missing feature from research - only recommend trades that improve starting lineup
    const lineupFilteredIdeas = ideas.filter((idea) => {
      // For sell trades, we don't need lineup impact check (we're clearing bench/aging assets)
      if (idea.type === "sell") return true;
      
      // For buy/upgrade/pick trades, check if received player would actually start
      if (idea.evalResult?.lineupImpactA) {
        const impact = idea.evalResult.lineupImpactA;
        
        // Filter out trades that:
        // 1. Don't improve starting lineup (pointsGained < 1.0)
        // 2. Are downgrades or strong downgrades
        // 3. Received player sits on bench (unless it's a 2-for-1 with significant consolidation)
        if (impact.recommendation === "strong_downgrade" || impact.recommendation === "downgrade") {
          return false;
        }
        
        if (impact.pointsGained < 1.0 && !impact.receivedPlayerStarts) {
          // Exception: 2-for-1 trades can be bench upgrades ONLY if they gain at least 2 PPG
          // This ensures we're consolidating into a meaningful upgrade, not just shuffling bench pieces
          if (idea.type === "2for1" && impact.pointsGained >= 2.0) return true;
          return false;
        }
      }
      
      return true;
    });

    // Calculate composite scores for all ideas
    const scoredIdeas = lineupFilteredIdeas.map((idea) => {
      const targetNeedLevel = myNeeds[idea.targetPlayer.position] || 0;
      const offeredPosition = idea.offeredPlayers[0]?.position;
      
      const positionalFit = calculatePositionalFit(
        idea.targetPlayer.position,
        myNeeds,
        offeredPosition
      );

      const tradeTypeForWindow = idea.type === "sell" ? "sell" : idea.type === "upgrade" ? "swap" : "buy";
      const otherCtx = leagueCtx.get(idea.targetTeamId);
      const windowAlignment = otherCtx
        ? calculateWindowAlignment(myCtx, otherCtx, tradeTypeForWindow)
        : 50;

      const isDeadZone = idea.type === "sell" && idea.priority === "high";
      const urgency = calculateUrgency(
        targetNeedLevel,
        myCtx.leagueRank,
        myCtx.totalTeams,
        isDeadZone
      );

      const scored = scoreRecommendation({
        valueGain: idea.valueDiff,
        positionalFit,
        acceptanceLikelihood: idea.acceptanceLikelihood,
        windowAlignment,
        urgency,
      });

      return {
        ...idea,
        compositeScore: scored.compositeScore,
        scoreExplanation: scored.explanation,
      };
    });

    // Filter out low-quality recommendations
    const qualityFiltered = scoredIdeas.filter((idea) => {
      const scored: ScoredRecommendation = {
        compositeScore: idea.compositeScore!,
        factors: {
          valueGain: idea.valueDiff,
          positionalFit: 0, // not needed for filter check
          acceptanceLikelihood: idea.acceptanceLikelihood,
          windowAlignment: 0,
          urgency: 0,
        },
        explanation: idea.scoreExplanation!,
      };
      
      // Filter out standard low-quality trades
      if (shouldFilterOut(scored)) return false;
      
      // Additional filter: trades with <35% acceptance AND negative value are unlikely to succeed
      // Exception: sell trades (we're trying to get value for aging assets)
      if (idea.type !== "sell" && idea.acceptanceLikelihood < 35 && idea.valueDiff < 0) {
        return false;
      }
      
      return true;
    });

    // Dedupe and cap sell-high spam
    const seen = new Set<string>();
    const sellCountByPlayer = new Map<string, number>();
    
    return qualityFiltered
      .sort((a, b) => {
        // Primary sort by composite score (descending)
        if (a.compositeScore !== b.compositeScore) {
          return (b.compositeScore || 0) - (a.compositeScore || 0);
        }
        // Tiebreaker: acceptance likelihood
        return b.acceptanceLikelihood - a.acceptanceLikelihood;
      })
      .filter((idea) => {
        // Dedupe per player+team — prevents same player appearing as buy+pick+2for1 from same team
        const key = `${idea.targetPlayer.id}-${idea.targetTeamId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        
        // Cap sell-high ideas at 2 per player being sold (reduced from 3)
        if (idea.type === "sell") {
          const soldId = idea.offeredPlayers.length > 0 ? idea.offeredPlayers[0].id : idea.targetPlayer.id;
          const count = sellCountByPlayer.get(soldId) ?? 0;
          if (count >= 2) return false;
          sellCountByPlayer.set(soldId, count + 1);
        }
        return true;
      })
      .slice(0, 15); // Cap at 15 recommendations (down from 25)
  }, [rosters, myTeamId, personalValues, leagueSettings, myRoster, tradeAnalysis, projAdjValues]);

  const filteredRecs = useMemo(() => {
    return recommendations.filter((idea) => {
      // Type/position filter
      if (filter !== "all") {
        if (filter === "buy" && idea.type === "sell") return false;
        if (filter === "sell" && idea.type !== "sell") return false;
        if (["QB", "RB", "WR", "TE"].includes(filter) && idea.targetPlayer.position !== filter) return false;
      }
      
      // Acceptance likelihood filter
      if (idea.acceptanceLikelihood < minAcceptance) return false;
      
      // Composite score filter
      if (idea.compositeScore !== undefined && idea.compositeScore < minScore) return false;
      
      return true;
    });
  }, [recommendations, filter, minAcceptance, minScore]);

  const sellHighCount = recommendations.filter((r) => r.type === "sell").length;
  const buyCount = recommendations.filter((r) => r.type !== "sell").length;

  const strategicPlan = useMemo((): StrategicPlan | null => {
    if (!myRoster || !leagueSettings || rosters.length === 0) return null;
    // Use same projection-adjusted values as the recommendations engine for consistency
    const planPValues: Record<string, number> = {
      ...projAdjValues,
      ...Object.fromEntries(Object.entries(personalValues).map(([id, v]) => [id, normVal(v)])),
    };
    const leagueCtx = buildLeagueContext(rosters, leagueSettings, planPValues);
    const myCtx = myTeamId ? leagueCtx.get(myTeamId) : undefined;
    if (!myCtx) return null;

    const initialNeeds = calculatePositionalNeed(myRoster.players, leagueSettings.rosterSlots, leagueSettings.superflex, planPValues);
    const strengths = Object.entries(initialNeeds).filter(([, n]) => n < 15).map(([pos]) => pos);
    const weaknesses = Object.entries(initialNeeds).filter(([, n]) => n > 28).sort(([, a], [, b]) => b - a).map(([pos]) => pos);
    const teamSummary = {
      window: myCtx.windowLabel,
      windowColor: myCtx.windowColor,
      rank: myCtx.leagueRank,
      avgAge: myCtx.avgAge,
      strengths,
      weaknesses,
      positionRanks: myCtx.relativePositionRanks,
      dynastyPowerScore: myCtx.dynastyPowerScore,
      pickSurplusLabel: myCtx.pickSurplusLabel,
      pickCapital: myCtx.pickCapital,
      totalTeams: myCtx.totalTeams,
    };

    // Window-appropriate strategy directive — aligned with WINDOW_LABELS thresholds
    const windowStrategy: Record<string, string> = {
      "Rebuilding":  "Accumulate picks and youth. Sell aging veterans for future capital. Patience is the move.",
      "Young Core":  "Target players 25 and under. Protect your best young assets — don't mortgage the future for an aging rental.",
      "Balanced":    "Balanced window: selectively upgrade. Prioritize players 24-28 who match your timeline.",
      "Competing":   "Upgrade proven starters in the 25-29 range. Mix now and future — avoid win-now overpays.",
      "Win Now":     "Maximize current production. Trade future capital for proven contributors — the window is open.",
    };
    const strategyText = windowStrategy[myCtx.windowLabel] ?? "Evaluate all trades carefully.";

    const steps: PlanStep[] = [];
    let simPlayers = [...myRoster.players];
    const usedKeys = new Set<string>();

    for (let phase = 1; phase <= 3; phase++) {
      const curNeeds = calculatePositionalNeed(simPlayers, leagueSettings.rosterSlots, leagueSettings.superflex, planPValues);
      // Bottom-third relative rank = structurally weak regardless of absolute need score
      const bottomThirdCutoff = Math.floor(myCtx.totalTeams * 2 / 3);
      const isUrgentNeed = (pos: string, n: number): boolean => {
        if (n > 28) return true;
        const relRank = myCtx.relativePositionRanks[pos];
        return relRank !== undefined && relRank > bottomThirdCutoff;
      };
      const topNeedEntry = Object.entries(curNeeds)
        .sort(([, a], [, b]) => b - a)
        .find(([pos, n]) => isUrgentNeed(pos, n));

      const availableSells = recommendations.filter(r =>
        r.type === "sell" &&
        !usedKeys.has(`${r.targetPlayer.id}-${r.targetTeamId}`) &&
        (
          (r.offeredPlayers.length > 0 && simPlayers.some(p => p.id === r.offeredPlayers[0].id)) ||
          (r.receivingPicks && simPlayers.some(p => p.id === r.targetPlayer.id))
        )
      );

      const urgentSell = availableSells.find(r => {
        const aging = r.offeredPlayers[0] ?? (r.receivingPicks ? r.targetPlayer : null);
        if (!aging) return false;
        // Dead zone players and rapidly declining curves are both urgent
        return myCtx.deadZonePlayerIds.includes(aging.id) ||
          getAssetTimeProfile(aging.position, aging.age).futureFactor < 0.5;
      });

      // Count ascending (futureFactor > 1.1) players per position — used to detect
      // positions already being built through draft capital so we don't double-dip.
      const ascendingCountByPos: Record<string, number> = {};
      for (const p of simPlayers) {
        if (!ascendingCountByPos[p.position]) ascendingCountByPos[p.position] = 0;
        // Only count players with real value — roster fillers with near-zero dynasty value
        // shouldn't block surfacing genuine upgrade opportunities.
        if (getAssetTimeProfile(p.position, p.age).futureFactor > 1.1 && getPlayerValue(p) >= 20) ascendingCountByPos[p.position]++;
      }
      // topNeedEntry is used only for HOLD context messaging; actual buy search iterates all needs.
      const posAlreadyBeingBuilt = topNeedEntry
        ? (ascendingCountByPos[topNeedEntry[0]] ?? 0) >= 2
        : false;

      // For Young Core / Rebuilding teams, only consider targets with real future upside
      const isWindowFit = (player: Player): boolean => {
        if (myCtx.winNowWeight > 0.42) return true; // Competing / Win Now: any age is fine
        const tp = getAssetTimeProfile(player.position, player.age);
        if (tp.futureFactor < 0.75) return false;
        // Hard age cap per position: QB curves have long shelves so futureFactor alone
        // won't filter a 30-year-old QB — add explicit caps for non-Win-Now teams.
        const posAgeCap: Record<string, number> = { QB: 30, RB: 25, WR: 28, TE: 30 };
        const cap = posAgeCap[player.position];
        if (cap !== undefined && player.age >= cap) return false;
        return true;
      };

      // Position viability: don't accept trades that strip a position below minimum depth
      const posMinViable: Record<string, number> = {
        QB: leagueSettings!.superflex ? 2 : 1,
        RB: 2, WR: 2, TE: 1,
      };
      const isPositionSafe = (r: TradeIdea) =>
        r.offeredPlayers.every(op => {
          const remaining = simPlayers.filter(p => p.position === op.position && p.id !== op.id).length;
          if (remaining < (posMinViable[op.position] ?? 1) + 1) return false;
          // Never offer the team's single most-valuable player at any position—they are untouchable
          const topAtPos = [...simPlayers]
            .filter(p => p.position === op.position)
            .sort((a, b) => getPlayerValue(b) - getPlayerValue(a))[0];
          if (topAtPos?.id === op.id) return false;
          return true;
        });

      // Iterate all need positions in descending order — skip those already being built organically.
      // Also include any position ranked bottom-third in the league, even if absolute need < 28%.
      const allNeedEntries = Object.entries(curNeeds)
        .filter(([pos, n]) => isUrgentNeed(pos, n))
        .sort(([posA, nA], [posB, nB]) => {
          // Composite urgency: absolute need% + relative rank severity
          // Rank in bottom third adds up to 50 urgency points (worst rank = +50)
          const rankA = myCtx.relativePositionRanks[posA] ?? 1;
          const rankB = myCtx.relativePositionRanks[posB] ?? 1;
          const rankUrgencyA = myCtx.totalTeams > 1 ? ((rankA - 1) / (myCtx.totalTeams - 1)) * 50 : 0;
          const rankUrgencyB = myCtx.totalTeams > 1 ? ((rankB - 1) / (myCtx.totalTeams - 1)) * 50 : 0;
          return (nB + rankUrgencyB) - (nA + rankUrgencyA);
        });
      let safeBuys: TradeIdea[] = [];
      for (const needEntry of allNeedEntries) {
        if ((ascendingCountByPos[needEntry[0]] ?? 0) >= 2) continue; // position already being built
        const buysForPos = recommendations.filter(r =>
          (r.type === "buy" || r.type === "upgrade" || r.type === "2for1" || r.type === "pick") &&
          r.targetPlayer.position === needEntry[0] &&
          !usedKeys.has(`${r.targetPlayer.id}-${r.targetTeamId}`) &&
          r.offeredPlayers.every(op => simPlayers.some(p => p.id === op.id)) &&
          isWindowFit(r.targetPlayer) &&
          r.verdictTone !== "bad"
        ).sort((a, b) => {
          if (Math.abs(a.valueDiff - b.valueDiff) > 5) return a.valueDiff - b.valueDiff;
          return b.acceptanceLikelihood - a.acceptanceLikelihood;
        });
        const safeForPos = buysForPos.filter(isPositionSafe);
        if (safeForPos.length > 0) {
          safeBuys = safeForPos;
          break;
        }
      }
      const safeSells = availableSells
        .filter(isPositionSafe)
        .sort((a, b) => {
          // Prefer player-for-player sells (you receive a player, not just a pick)
          // A young player return is always more valuable than an equivalent pick
          const aIsPlayer = a.offeredPlayers.length > 0;
          const bIsPlayer = b.offeredPlayers.length > 0;
          if (aIsPlayer !== bIsPlayer) return aIsPlayer ? -1 : 1;
          return b.acceptanceLikelihood - a.acceptanceLikelihood;
        });
      const safeUrgentSell = urgentSell && isPositionSafe(urgentSell) ? urgentSell : null;

      let chosen: TradeIdea | null = null;
      let chosenType: "buy" | "sell" | "hold" = "hold";
      if (safeUrgentSell) { chosen = safeUrgentSell; chosenType = "sell"; }
      else if (safeBuys.length > 0) { chosen = safeBuys[0]; chosenType = "buy"; }
      else if (safeSells.length > 0) { chosen = safeSells[0]; chosenType = "sell"; }

      if (!chosen) {
        const rank = myCtx.leagueRank;
        const totalTeams = myCtx.totalTeams;
        const belowMedian = rank > Math.ceil(totalTeams / 2);

        // Dead zone override: if no trade found but we have dead zone assets, push a sell directive
        const uncoveredDeadZone = myCtx.deadZonePlayerIds
          .map(id => simPlayers.find(p => p.id === id))
          .filter(Boolean) as Player[];
        if (uncoveredDeadZone.length > 0) {
          const dzp = uncoveredDeadZone[0];
          steps.push({
            phase,
            type: "sell",
            headline: `Shop ${dzp.name} Now — Dead Zone Asset`,
            context: `${dzp.name} (age ${dzp.age}, ${dzp.position}) is in the dead zone: still has tradeable value but losing it fast every month. Actively shop to all 13 teams now before the market prices in the decline.`,
            needsBefore: curNeeds,
          });
          break;
        }

        let holdHeadline: string;
        let holdContext: string;
        if (posAlreadyBeingBuilt && topNeedEntry) {
          const pos = topNeedEntry[0];
          const developingPlayers = simPlayers
            .filter(p => p.position === pos && getAssetTimeProfile(p.position, p.age).futureFactor > 1.1 && getPlayerValue(p) >= 15)
            .sort((a, b) => getPlayerValue(b) - getPlayerValue(a))
            .slice(0, 3);
          holdHeadline = `Let Your Young ${pos}s Develop`;
          holdContext = `You already have ${developingPlayers.map(p => `${p.name} (age ${p.age})`).join(" and ")} coming up at ${pos}. Hold your capital and let them develop — adding another ${pos} would be redundant.`;
        } else if (belowMedian) {
          // Use worst relative position rank for a specific, actionable message
          const worstRelPos = Object.entries(myCtx.relativePositionRanks)
            .sort(([, a], [, b]) => b - a)
            .find(([, r]) => r > Math.ceil(totalTeams / 2));
          if (worstRelPos) {
            holdHeadline = `Build Up ${worstRelPos[0]} — You Rank #${worstRelPos[1]} of ${totalTeams}`;
            holdContext = `Your ${worstRelPos[0]} group ranks #${worstRelPos[1]} of ${totalTeams} teams (Dynasty Score: ${myCtx.dynastyPowerScore}/100). No clean trades surfaced right now — continue targeting ${worstRelPos[0]} upgrades and monitor all rosters.`;
          } else {
            holdHeadline = `Improve Value at ${topNeedEntry?.[0] ?? "Key Positions"}`;
            holdContext = `Ranked #${rank} of ${totalTeams} (Dynasty Score: ${myCtx.dynastyPowerScore}/100). No clean trades surfaced — continue targeting ${topNeedEntry?.[0] ?? "all positions"} upgrades.`;
          }
        } else {
          holdHeadline = "Hold & Let Roster Develop";
          holdContext = `Dynasty Score ${myCtx.dynastyPowerScore}/100. Your roster needs are balanced — let young players grow into contributors. No urgent moves needed right now.`;
        }
        steps.push({ phase, type: "hold", headline: holdHeadline, context: holdContext, needsBefore: curNeeds });
        break;
      }

      usedKeys.add(`${chosen.targetPlayer.id}-${chosen.targetTeamId}`);

      // Simulate trade on roster
      if (chosenType === "sell") {
        if (chosen.offeredPlayers.length > 0) {
          simPlayers = simPlayers.filter(p => p.id !== chosen!.offeredPlayers[0].id);
          simPlayers.push(chosen.targetPlayer);
        } else if (chosen.receivingPicks) {
          simPlayers = simPlayers.filter(p => p.id !== chosen!.targetPlayer.id);
        }
      } else {
        simPlayers = simPlayers.filter(p => !chosen!.offeredPlayers.some(op => op.id === p.id));
        simPlayers.push(chosen.targetPlayer);
      }

      const needsAfter = calculatePositionalNeed(simPlayers, leagueSettings.rosterSlots, leagueSettings.superflex, planPValues);

      let headline: string;
      if (chosenType === "sell") {
        if (chosen.offeredPlayers.length > 0) headline = `Sell ${chosen.offeredPlayers[0].name} → Get ${chosen.targetPlayer.name}`;
        else if (chosen.receivingPicks) headline = `Sell ${chosen.targetPlayer.name} → ${chosen.receivingPicks[0].year} R${chosen.receivingPicks[0].round}`;
        else headline = "Sell High";
      } else {
        const offer = [...chosen.offeredPlayers.map(p => p.name), ...(chosen.offeredPicks?.map(p => `${p.year} R${p.round}`) || [])].join(" + ");
        headline = `Send ${offer} → Get ${chosen.targetPlayer.name}`;
      }

      const fixedPos = topNeedEntry?.[0];
      const remainingTop = Object.entries(needsAfter).sort(([, a], [, b]) => b - a)[0];
      let context = chosen.reason;
      if (fixedPos) {
        const before = Math.round(curNeeds[fixedPos] || 0);
        const after = Math.round(needsAfter[fixedPos] || 0);
        if (after < before) context += ` Drops your ${fixedPos} need from ${before}% → ${after}%.`;
      }
      if (remainingTop && remainingTop[1] > 30 && remainingTop[0] !== fixedPos) {
        context += ` Next priority: ${remainingTop[0]}.`;
      }

      steps.push({ phase, type: chosenType, trade: chosen, headline, context, needsBefore: curNeeds, needsAfter });
    }

    return { teamSummary, windowStrategy: strategyText, steps };
  }, [recommendations, myRoster, leagueSettings, personalValues, rosters, myTeamId, projAdjValues]);

  if (!myRoster || rosters.length === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight gradient-text">Trade Finder</h1>
          <p className="text-muted-foreground mt-2 text-lg">Connect your league to get personalized trade recommendations</p>
        </div>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Lightbulb className="h-16 w-16 text-muted-foreground mb-6" />
            <h2 className="text-xl font-semibold mb-2">No League Data</h2>
            <p className="text-muted-foreground">Import your league first to see trade recommendations.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const myNeeds = calculatePositionalNeed(
    myRoster.players,
    leagueSettings?.rosterSlots || [],
    leagueSettings?.superflex || false,
    personalValues
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight gradient-text">Trade Finder</h1>
        <p className="text-muted-foreground mt-2 text-base sm:text-lg">
          AI-powered trade recommendations based on roster needs, value gaps, and league dynamics
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 sm:gap-6 text-xs sm:text-sm">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500"></div>
            <span className="text-muted-foreground"><span className="font-semibold text-foreground">Acceptance %</span> = Likelihood opponent accepts</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500"></div>
            <span className="text-muted-foreground"><span className="font-semibold text-foreground">Score</span> = Overall trade quality (0-100)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-orange-500"></div>
            <span className="text-muted-foreground"><span className="font-semibold text-foreground">Priority</span> = How urgently you need this</span>
          </div>
        </div>
      </div>

      {/* Strategic Plan */}
      {strategicPlan && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              <h2 className="text-xl font-bold">Plan of Attack</h2>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 text-xs sm:text-sm flex-wrap">
              <span className={`font-medium ${strategicPlan.teamSummary.windowColor}`}>
                {strategicPlan.teamSummary.window}
              </span>
              <span className="text-muted-foreground">#{strategicPlan.teamSummary.rank} of {strategicPlan.teamSummary.totalTeams}</span>
              <span className="text-muted-foreground">Age {strategicPlan.teamSummary.avgAge.toFixed(1)}</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                strategicPlan.teamSummary.dynastyPowerScore >= 65 ? "bg-green-500/10 text-green-400 border-green-500/30" :
                strategicPlan.teamSummary.dynastyPowerScore >= 40 ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30" :
                "bg-red-500/10 text-red-400 border-red-500/30"
              }`}>
                Dynasty ⚡ {strategicPlan.teamSummary.dynastyPowerScore}
              </span>
              <span className={`text-xs font-medium ${
                strategicPlan.teamSummary.pickSurplusLabel === "surplus" ? "text-green-400" :
                strategicPlan.teamSummary.pickSurplusLabel === "deficit" ? "text-red-400" :
                "text-muted-foreground"
              }`}>
                Picks: {strategicPlan.teamSummary.pickSurplusLabel}
              </span>
            </div>
          </div>

          {/* Roster state summary */}
          <Card className="modern-card border-primary/20">
            <CardContent className="py-3">
              <div className="flex gap-6 flex-wrap">
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Depth</p>
                  <div className="flex gap-1.5">
                    {strategicPlan.teamSummary.strengths.length > 0
                      ? strategicPlan.teamSummary.strengths.map(pos => (
                          <Badge key={pos} variant="outline" className={`text-xs ${positionColors[pos]}`}>{pos} ✓</Badge>
                        ))
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Needs</p>
                  <div className="flex gap-1.5">
                    {strategicPlan.teamSummary.weaknesses.length > 0
                      ? strategicPlan.teamSummary.weaknesses.map(pos => (
                          <Badge key={pos} variant="outline" className="text-xs text-red-400 border-red-500/30">{pos}</Badge>
                        ))
                      : <span className="text-xs text-green-400">Balanced</span>}
                  </div>
                </div>
                {/* Position league ranks */}
                <div className="ml-auto">
                  <p className="text-xs text-muted-foreground mb-1.5">Position Rank (of {strategicPlan.teamSummary.totalTeams})</p>
                  <div className="flex gap-3">
                    {(["QB","RB","WR","TE"] as const).map(pos => {
                      const r = strategicPlan.teamSummary.positionRanks[pos];
                      if (r === undefined) return null;
                      const isGood = r <= Math.ceil(strategicPlan.teamSummary.totalTeams / 3);
                      const isBad = r > Math.floor(strategicPlan.teamSummary.totalTeams * 2 / 3);
                      return (
                        <div key={pos} className="text-center">
                          <p className={`text-xs font-bold ${
                            isGood ? "text-green-400" : isBad ? "text-red-400" : "text-yellow-400"
                          }`}>#{r}</p>
                          <p className="text-[10px] text-muted-foreground">{pos}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Window strategy directive */}
          <div className="px-3 py-2 rounded-lg bg-muted/40 border border-border/40 text-xs text-muted-foreground">
            <span className={`font-semibold ${strategicPlan.teamSummary.windowColor} mr-1.5`}>Strategy:</span>
            {strategicPlan.windowStrategy}
          </div>

          {/* Steps timeline */}
          <div className="space-y-2">
            {strategicPlan.steps.map((step, idx) => (
              <div key={idx} className="flex gap-3">
                {/* Phase indicator + connector */}
                <div className="flex flex-col items-center pt-1">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                    step.type === "sell" ? "bg-orange-500/20 text-orange-400 border border-orange-500/40" :
                    step.type === "buy" ? "bg-blue-500/20 text-blue-400 border border-blue-500/40" :
                    "bg-muted text-muted-foreground border border-border"
                  }`}>{step.phase}</div>
                  {idx < strategicPlan.steps.length - 1 && (
                    <div className="w-px flex-1 bg-border/50 my-1.5" />
                  )}
                </div>

                {/* Step card */}
                <Card className={`modern-card flex-1 mb-1 ${
                  step.type === "sell" ? "border-orange-500/20" :
                  step.type === "buy" ? "border-blue-500/20" :
                  "border-border/50"
                }`}>
                  <CardContent className="py-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs font-bold ${
                            step.type === "sell" ? "text-orange-400" :
                            step.type === "buy" ? "text-blue-400" :
                            "text-muted-foreground"
                          }`}>
                            {step.type === "sell" ? "SELL HIGH" : step.type === "buy" ? "ACQUIRE" : "HOLD"}
                          </span>
                          {step.trade && (
                            <Badge variant="outline" className={`text-xs ${positionColors[step.trade.targetPlayer.position] || ""}`}>
                              {step.trade.targetPlayer.position}
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm font-semibold mb-1">{step.headline}</p>
                        {step.trade && (
                          <p className="text-xs text-muted-foreground mb-1">via {step.trade.targetTeamName}</p>
                        )}
                        <p className="text-xs text-muted-foreground leading-relaxed">{step.context}</p>
                        {step.trade && (
                          <div className="flex items-center gap-3 mt-2">
                            <button
                              onClick={() => handleViewInSimulator(step.trade!)}
                              className="text-xs px-2.5 py-1 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors flex items-center gap-1"
                            >
                              <ArrowRightLeft className="h-3 w-3" />
                              Simulate
                            </button>
                            <span className={`text-xs font-medium ${acceptLabel(step.trade.acceptanceLikelihood)}`}>
                              {Math.round(step.trade.acceptanceLikelihood)}% accept chance
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Mini needs-after display */}
                      {step.needsAfter && (
                        <div className="shrink-0 space-y-1.5 text-right">
                          <p className="text-xs text-muted-foreground">After</p>
                          {Object.entries(step.needsAfter)
                            .sort(([, a], [, b]) => b - a)
                            .map(([pos, need]) => (
                              <div key={pos} className="flex items-center gap-1.5 justify-end">
                                <span className="text-xs text-muted-foreground w-4">{pos}</span>
                                <div className="w-14 h-1.5 bg-muted rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all ${
                                      need > 40 ? "bg-red-500" : need > 20 ? "bg-yellow-500" : "bg-green-500"
                                    }`}
                                    style={{ width: `${Math.min(need, 100)}%` }}
                                  />
                                </div>
                              </div>
                            ))
                          }
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            ))}
          </div>

          <div className="border-t border-border/50 pt-2">
            <p className="text-xs text-muted-foreground">Browse individual trade ideas below</p>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="modern-card">
          <CardContent className="py-4 text-center">
            <p className="text-2xl font-bold font-mono gradient-text">{buyCount}</p>
            <p className="text-xs text-muted-foreground mt-1">Buy Opportunities</p>
          </CardContent>
        </Card>
        <Card className="modern-card">
          <CardContent className="py-4 text-center">
            <p className="text-2xl font-bold font-mono text-orange-400">{sellHighCount}</p>
            <p className="text-xs text-muted-foreground mt-1">Sell-High Alerts</p>
          </CardContent>
        </Card>
        <Card className="modern-card">
          <CardContent className="py-4 text-center">
            <p className="text-2xl font-bold font-mono">{recommendations.length}</p>
            <p className="text-xs text-muted-foreground mt-1">Total Ideas</p>
          </CardContent>
        </Card>
      </div>

      {/* Positional needs */}
      <Card className="modern-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-5 w-5" />
            Your Positional Needs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4">
            {Object.entries(myNeeds).map(([pos, need]) => (
              <div key={pos} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className={positionColors[pos] || ""}>{pos}</Badge>
                  <span className={`text-xs font-medium ${need > 40 ? "text-red-400" : need > 20 ? "text-yellow-400" : "text-green-400"}`}>
                    {need > 40 ? "High Need" : need > 20 ? "Moderate" : "Stacked"}
                  </span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${need > 40 ? "bg-red-500" : need > 20 ? "bg-yellow-500" : "bg-green-500"}`}
                    style={{ width: `${Math.min(need, 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardContent className="py-4 space-y-4">
          {/* Filter tabs */}
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="h-4 w-4 text-muted-foreground" />
            {(["all", "buy", "sell", "QB", "RB", "WR", "TE"] as FilterType[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  filter === f
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {f === "all" ? "All" : f === "buy" ? "Buy" : f === "sell" ? "Sell High" : f}
                {f === "sell" && sellHighCount > 0 && (
                  <span className="ml-1.5 bg-orange-500/20 text-orange-400 text-xs px-1.5 py-0.5 rounded-full">
                    {sellHighCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Slider filters */}
          <div className="grid grid-cols-2 gap-6 pt-2 border-t border-border/50">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Min Acceptance</label>
                <span className="text-xs font-bold text-foreground">{minAcceptance}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={minAcceptance}
                onChange={(e) => setMinAcceptance(Number(e.target.value))}
                className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>
            
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Min Score</label>
                <span className="text-xs font-bold text-foreground">{minScore}</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>
          </div>

          {/* Active filter summary */}
          {(minAcceptance > 0 || minScore > 0) && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t border-border/50">
              <span>Active filters:</span>
              {minAcceptance > 0 && <span className="bg-muted px-2 py-1 rounded">≥{minAcceptance}% acceptance</span>}
              {minScore > 0 && <span className="bg-muted px-2 py-1 rounded">≥{minScore} score</span>}
              <button
                onClick={() => { setMinAcceptance(0); setMinScore(0); }}
                className="ml-auto text-primary hover:underline"
              >
                Clear filters
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quality Insights */}
      {recommendations.length > 0 && (
        <Card className="bg-muted/30">
          <CardContent className="py-3">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                <span className="font-medium">Quality Filter Active</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>Showing <span className="font-bold text-foreground">{filteredRecs.length}</span> of <span className="font-bold text-foreground">{recommendations.length}</span> recommendations</span>
                {recommendations.length > 0 && (
                  <span className="text-green-400">
                    ✓ Low-quality trades filtered out
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recommendations */}
      {filteredRecs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-lg font-semibold mb-2">No Recommendations</h2>
            <p className="text-muted-foreground text-center max-w-md text-sm">
              {recommendations.length === 0
                ? "No trade ideas found. Customize player values to find buy-low opportunities, or ensure your league data is loaded."
                : "No trades match the current filter. Try a different category."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredRecs.map((idea, idx) => {
            const tc = typeConfig[idea.type];
            const isExpanded = expandedIdx === idx;
            const isSell = idea.type === "sell";
            const isSellForPick = isSell && !!idea.receivingPicks?.length && idea.offeredPlayers.length === 0;
            // For sell trades show position of what you're TRADING AWAY, not what you receive
            const displayPosition = isSell && idea.offeredPlayers.length > 0
              ? idea.offeredPlayers[0].position : idea.targetPlayer.position;

            return (
              <Card key={idx} className="modern-card hover:border-primary/30 transition-all animate-fade-in" style={{ animationDelay: `${idx * 30}ms` }}>
                <CardContent className="py-4">
                  {/* Top row: type badge + priority + position + player name */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded border ${tc.color} ${tc.bg}`}>
                          {tc.label}
                        </span>
                        <Badge
                          variant={idea.priority === "high" ? "destructive" : idea.priority === "medium" ? "secondary" : "outline"}
                          className="text-xs capitalize"
                        >
                          {idea.priority}
                        </Badge>
                        <Badge variant="outline" className={`text-xs ${positionColors[displayPosition] || ""}`}>
                          {displayPosition}
                        </Badge>
                      </div>

                      {/* Trade summary */}
                      <div className="flex items-center gap-2 flex-wrap text-sm mb-1">
                        {isSellForPick ? (
                          <>
                            <span className="text-muted-foreground">Sell</span>
                            <span className="font-semibold">{idea.targetPlayer.name}</span>
                            {idea.targetPlayer.injuryStatus && idea.targetPlayer.injuryStatus !== "active" && (
                              <Badge variant="outline" className="text-xs border-red-500/50 text-red-400 bg-red-500/10">
                                {idea.targetPlayer.injuryStatus.toUpperCase()}
                              </Badge>
                            )}
                            <span className="text-muted-foreground text-xs">({getPlayerValue(idea.targetPlayer).toLocaleString()})</span>
                            {getEdgeBadge(idea.targetPlayer)}
                            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-muted-foreground">
                              {idea.receivingPicks?.map((p) => `${p.year} R${p.round}`).join(", ")} from {idea.targetTeamName}
                            </span>
                          </>
                        ) : isSell ? (
                          <>
                            <span className="text-muted-foreground">Sell</span>
                            <span className="font-semibold">{idea.offeredPlayers[0]?.name}</span>
                            {idea.offeredPlayers[0]?.injuryStatus && idea.offeredPlayers[0].injuryStatus !== "active" && (
                              <Badge variant="outline" className="text-xs border-red-500/50 text-red-400 bg-red-500/10">
                                {idea.offeredPlayers[0].injuryStatus.toUpperCase()}
                              </Badge>
                            )}
                            <span className="text-muted-foreground text-xs">({idea.offeredPlayers[0] ? getPlayerValue(idea.offeredPlayers[0]).toLocaleString() : ""})</span>
                            {idea.offeredPlayers[0] && getEdgeBadge(idea.offeredPlayers[0])}
                            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="font-semibold">{idea.targetPlayer.name}</span>
                            {idea.targetPlayer.injuryStatus && idea.targetPlayer.injuryStatus !== "active" && (
                              <Badge variant="outline" className="text-xs border-red-500/50 text-red-400 bg-red-500/10">
                                {idea.targetPlayer.injuryStatus.toUpperCase()}
                              </Badge>
                            )}
                            <span className="text-muted-foreground text-xs">({getPlayerValue(idea.targetPlayer).toLocaleString()})</span>
                            <span className="text-muted-foreground text-xs">from {idea.targetTeamName}</span>
                          </>
                        ) : (
                          <>
                            <span className="text-muted-foreground">Target:</span>
                            <span className="font-semibold">{idea.targetPlayer.name}</span>
                            {idea.targetPlayer.injuryStatus && idea.targetPlayer.injuryStatus !== "active" && (
                              <Badge variant="outline" className="text-xs border-red-500/50 text-red-400 bg-red-500/10">
                                {idea.targetPlayer.injuryStatus.toUpperCase()}
                              </Badge>
                            )}
                            <span className="text-muted-foreground text-xs">({getPlayerValue(idea.targetPlayer).toLocaleString()})</span>
                            {getEdgeBadge(idea.targetPlayer)}
                            <span className="text-muted-foreground text-xs">from {idea.targetTeamName}</span>
                          </>
                        )}
                      </div>

                      {/* Offer summary (for buy trades) */}
                      {!isSell && (idea.offeredPlayers.length > 0 || idea.offeredPicks?.length) && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                          <span>Offer:</span>
                          {idea.offeredPlayers.map((p) => (
                            <span key={p.id} className="bg-muted/60 px-2 py-0.5 rounded">
                              {p.name} <span className="text-muted-foreground/70">({getPlayerValue(p).toLocaleString()})</span>
                            </span>
                          ))}
                          {idea.offeredPicks?.map((p, i) => (
                            <span key={i} className="bg-muted/60 px-2 py-0.5 rounded">{p.year} R{p.round}</span>
                          ))}
                        </div>
                      )}

                      <p className="text-xs text-muted-foreground">{idea.reason}</p>
                    </div>

                    {/* Scores */}
                    <div className="flex flex-col items-end gap-3 shrink-0">
                      {/* Composite Score */}
                      {idea.compositeScore !== undefined && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger className="text-center cursor-help">
                              <div className="flex flex-col items-center">
                                <p className={`text-3xl font-black font-mono ${
                                  idea.compositeScore >= 70 ? "text-green-400" :
                                  idea.compositeScore >= 55 ? "text-emerald-400" :
                                  idea.compositeScore >= 40 ? "text-yellow-400" :
                                  "text-orange-400"
                                }`}>
                                  {Math.round(idea.compositeScore)}
                                </p>
                                <p className="text-[10px] text-muted-foreground leading-tight uppercase tracking-wide">Quality</p>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="max-w-sm">
                              <p className="font-semibold mb-1">Trade Quality Score</p>
                              <p className="text-xs leading-relaxed">{idea.scoreExplanation}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      
                      {/* Lineup Impact Badge */}
                      {idea.evalResult?.lineupImpactA && !isSell && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger className="cursor-help">
                              <Badge 
                                variant="outline" 
                                className={`text-xs font-semibold ${
                                  idea.evalResult.lineupImpactA.recommendation === "strong_upgrade" ? "border-green-500/50 text-green-400 bg-green-500/10" :
                                  idea.evalResult.lineupImpactA.recommendation === "upgrade" ? "border-emerald-500/50 text-emerald-400 bg-emerald-500/10" :
                                  idea.evalResult.lineupImpactA.recommendation === "lateral" ? "border-yellow-500/50 text-yellow-400 bg-yellow-500/10" :
                                  "border-orange-500/50 text-orange-400 bg-orange-500/10"
                                }`}
                              >
                                {idea.evalResult.lineupImpactA.receivedPlayerStarts ? "🔥 Starter" : "📦 Bench"}
                                {idea.evalResult.lineupImpactA.pointsGained > 0 && (
                                  <span className="ml-1">+{idea.evalResult.lineupImpactA.pointsGained.toFixed(1)}</span>
                                )}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              <p className="text-xs">
                                {idea.evalResult.lineupImpactA.receivedPlayerStarts 
                                  ? `${idea.targetPlayer.name} would start for you` 
                                  : `${idea.targetPlayer.name} would sit on your bench`}
                                {idea.evalResult.lineupImpactA.pointsGained !== 0 && (
                                  <span className="block mt-1">
                                    Lineup impact: {idea.evalResult.lineupImpactA.pointsGained > 0 ? '+' : ''}{idea.evalResult.lineupImpactA.pointsGained.toFixed(1)} PPG
                                  </span>
                                )}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      
                      {/* Acceptance likelihood */}
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger className="cursor-help">
                            <div className="flex flex-col items-center gap-1">
                              <div className="text-center">
                                <p className={`text-2xl font-black font-mono ${acceptLabel(idea.acceptanceLikelihood)}`}>
                                  {Math.round(idea.acceptanceLikelihood)}%
                                </p>
                                <p className="text-[10px] text-muted-foreground leading-tight uppercase tracking-wide">Accept</p>
                              </div>
                              <div className="w-20 h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${acceptColor(idea.acceptanceLikelihood)}`}
                                  style={{ width: `${Math.min(idea.acceptanceLikelihood, 100)}%` }}
                                />
                              </div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            <p className="font-semibold mb-1">Acceptance Likelihood</p>
                            <p className="text-xs">Probability {idea.targetTeamName} accepts this trade</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
                    <button
                      onClick={() => handleViewInSimulator(idea)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5" />
                      Simulate
                    </button>
                    <button
                      onClick={() => handleFeedback(idea, "thumbs_up")}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-green-400 hover:bg-green-500/10 transition-colors"
                    >
                      <ThumbsUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleFeedback(idea, "thumbs_down")}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <ThumbsDown className="h-3.5 w-3.5" />
                    </button>
                    {(idea.tradeOptions && idea.tradeOptions.length > 1) || (idea.roadmap && idea.roadmap.length > 0) ? (
                      <button
                        onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                        className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                      >
                        {isExpanded ? "Less" : "More details"}
                        <span>{isExpanded ? "▲" : "▼"}</span>
                      </button>
                    ) : null}
                  </div>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="mt-3 space-y-3">
                      {idea.tradeOptions && idea.tradeOptions.length > 1 && (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                            <Zap className="h-3 w-3" /> Alternative offers
                          </p>
                          <div className="space-y-1.5">
                            {idea.tradeOptions.map((option, optIdx) => (
                              <div key={optIdx} className="flex items-center justify-between text-xs p-2 bg-muted/30 rounded-lg">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{option.offerPlayer.name}</span>
                                  <Badge variant="outline" className={`text-xs ${positionColors[option.offerPlayer.position] || ""}`}>
                                    {option.offerPlayer.position}
                                  </Badge>
                                  <span className="text-muted-foreground">{option.offerValue.toLocaleString()}</span>
                                </div>
                                <span className={`font-medium ${acceptLabel(option.acceptance)}`}>{Math.round(option.acceptance)}%</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {idea.roadmap && idea.roadmap.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                            <Lightbulb className="h-3 w-3" /> Post-trade roadmap
                          </p>
                          <div className="space-y-1.5 pl-3 border-l-2 border-primary/30">
                            {idea.roadmap.map((step, stepIdx) => (
                              <p key={stepIdx} className="text-xs text-muted-foreground">{step}</p>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
