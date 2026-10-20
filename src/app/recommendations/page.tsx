"use client";

// Normalize any player value to 0-100 scale.
// Values > 150: FantasyCalc 0-10000 — divide by 100 and cap. Values 0-150: already 0-100 — just cap.
const normVal = (v: number): number =>
  v > 150 ? Math.min(100, Math.round(v / 100)) : Math.min(100, v);

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { arePlayerStatsStale, useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { RecommendationFactors } from "@/components/recommendation-factors";
import { DEFAULT_DYNASTY_VALUES, calculatePositionalNeed } from "@/lib/player-values";
import { buildLeagueContext, computeAllProjections } from "@/lib/analytics";
import { recommendationTradeParams } from "@/lib/recommendations/navigation";
import { generateRecommendationCandidates } from "@/lib/recommendations/candidates";
import { evaluateRecommendationCandidates } from "@/lib/recommendations/pipeline";
import { buildStrategicPlan } from "@/lib/recommendations/strategic-plan";
import { rankRecommendations } from "@/lib/recommendations/ranking";
import { getRecommendationEmptyState } from "@/lib/recommendations/empty-state";
import type { TradeIdea, TradeType } from "@/lib/recommendations/types";
import type { Player, PlayerProjection, RosterSlot } from "@/types";
import {
  Lightbulb,
  ArrowRight,
  Target,
  AlertCircle,
  ThumbsUp,
  ThumbsDown,
  ArrowRightLeft,
  Zap,
  Filter,
  X,
} from "lucide-react";

const positionColors: Record<string, string> = {
  QB: "text-red-400 border-red-500/30",
  RB: "text-green-400 border-green-500/30",
  WR: "text-blue-400 border-blue-500/30",
  TE: "text-orange-400 border-orange-500/30",
};

type FilterType = "all" | "buy" | "sell" | "QB" | "RB" | "WR" | "TE";
type PositionFilter = "QB" | "RB" | "WR" | "TE";

function subscribeToLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function getPositionFromLocation(): PositionFilter | null {
  const position = new URLSearchParams(window.location.search).get("position");
  return position === "QB" || position === "RB" || position === "WR" || position === "TE"
    ? position
    : null;
}

function getServerPosition(): null {
  return null;
}

const typeConfig: Record<TradeType, { label: string; color: string; bg: string }> = {
  buy: { label: "BUY", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/30" },
  sell: { label: "SELL HIGH", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/30" },
  upgrade: { label: "UPGRADE", color: "text-green-400", bg: "bg-green-500/10 border-green-500/30" },
  "2for1": { label: "2-FOR-1", color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/30" },
  pick: { label: "PICK TRADE", color: "text-cyan-400", bg: "bg-cyan-500/10 border-cyan-500/30" },
  "buy-low": { label: "BUY LOW", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/30" },
};

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
  const {
    rosters, myTeamId, personalValues, leagueSettings, addTradeFeedback, tradeAnalysis,
    playerStats, statsLoading, statsError, statsLastFetched, loadPlayerStats,
  } = useAppStore();
  const statsRequestLeagueRef = useRef<string | null>(null);
  const [filter, setFilter] = useState<FilterType>("all");
  const [focusDismissed, setFocusDismissed] = useState(false);
  const urlPosition = useSyncExternalStore(subscribeToLocation, getPositionFromLocation, getServerPosition);
  const focusedPosition = focusDismissed ? null : urlPosition;
  const effectiveFilter: FilterType = focusedPosition ?? filter;
  const [minAcceptance, setMinAcceptance] = useState(0);
  const [minScore, setMinScore] = useState(0);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [needsTeamId, setNeedsTeamId] = useState<string>("mine");

  const selectFilter = (nextFilter: FilterType) => {
    setFilter(nextFilter);
    if (focusedPosition) {
      setFocusDismissed(true);
      router.replace("/recommendations", { scroll: false });
    }
  };

  const myRoster = rosters.find((r) => r.teamId === myTeamId);

  useEffect(() => {
    if (!leagueSettings || rosters.length === 0 || !arePlayerStatsStale(statsLastFetched)) return;
    if (statsRequestLeagueRef.current === leagueSettings.id) return;
    statsRequestLeagueRef.current = leagueSettings.id;
    void loadPlayerStats();
  }, [leagueSettings, rosters.length, statsLastFetched, loadPlayerStats]);

  const getPlayerValue = useCallback((player: Player): number => {
    const raw = personalValues[player.id] ?? player.dynastyValue ?? DEFAULT_DYNASTY_VALUES[player.name] ?? 10;
    return normVal(raw);
  }, [personalValues]);

  // Proprietary projections (Tier 1 always available; Tier 2+3 after stats load)
  const projections = useMemo((): Record<string, PlayerProjection> => {
    if (!leagueSettings || rosters.length === 0) return {};
    return computeAllProjections(rosters.flatMap((r) => r.players), leagueSettings, playerStats);
  }, [rosters, leagueSettings, playerStats]);

  const lineupPointEstimates = useMemo(() => Object.fromEntries(
    Object.entries(projections)
      .filter((entry): entry is [string, PlayerProjection & { fppg: number }] => Number.isFinite(entry[1].fppg))
      .map(([id, projection]) => [id, projection.fppg]),
  ), [projections]);

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
    router.push(`/trade?${recommendationTradeParams(idea, myTeamId).toString()}`);
  };

  const generateTradeRoadmap = useCallback((
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
  }, [getPlayerValue, myTeamId, rosters]);

  // This is the expensive stage: league context, package construction, trade
  // evaluation, and quality scoring. Keep UI-only filters out of its dependencies.
  const recommendationResult = useMemo((): { candidateCount: number; recommendations: TradeIdea[] } => {
    if (!myRoster || !myTeamId || !leagueSettings || rosters.length === 0) {
      return { candidateCount: 0, recommendations: [] };
    }

    // Merge projection-adjusted values (0-100) with user overrides (normalized to 0-100).
    // Personal overrides always win; projection adjustments fill in the rest.
    const effectivePValues: Record<string, number> = {
      ...projAdjValues,
      ...Object.fromEntries(Object.entries(personalValues).map(([id, v]) => [id, normVal(v)])),
    };

    const ideas: TradeIdea[] = [];
    // Use projection-adjusted values for all context — ensures needs + acceptance use same value basis
    const leagueCtx = buildLeagueContext(rosters, leagueSettings, effectivePValues);
    const myCtx = leagueCtx.get(myTeamId);
    if (!myCtx) return { candidateCount: 0, recommendations: [] };

    const myNeeds = calculatePositionalNeed(myRoster.players, leagueSettings.rosterSlots, leagueSettings.superflex, effectivePValues);

    ideas.push(...generateRecommendationCandidates({
      rosters, myTeamId, myRoster, myTeam: myCtx, league: leagueCtx,
      needs: myNeeds, projections, lineupPointEstimates, personalValues, effectiveValues: effectivePValues,
      leagueSettings, getPlayerValue,
    }, tradeAnalysis, generateTradeRoadmap));
    const qualityFiltered = evaluateRecommendationCandidates(ideas, {
      needs: myNeeds,
      myTeam: myCtx,
      league: leagueCtx,
      mode: leagueSettings.mode,
    });

    return { candidateCount: ideas.length, recommendations: qualityFiltered };
  }, [rosters, myTeamId, personalValues, leagueSettings, myRoster, tradeAnalysis, projAdjValues, projections, lineupPointEstimates, getPlayerValue, generateTradeRoadmap]);

  const evaluatedRecommendations = recommendationResult.recommendations;

  // Ranking and focus are cheap presentation operations. Deep-linking to a
  // position no longer regenerates every candidate and reevaluates every trade.
  const recommendations = useMemo(
    () => rankRecommendations(evaluatedRecommendations, { focusedPosition, limit: focusedPosition ? 15 : 100 }),
    [evaluatedRecommendations, focusedPosition],
  );

  // The strategic plan should remain stable when the user changes display
  // filters or opens a position-focused link.
  const planRecommendations = useMemo(
    () => rankRecommendations(evaluatedRecommendations, { limit: 15 }),
    [evaluatedRecommendations],
  );

  const filteredRecs = useMemo(() => {
    return recommendations.filter((idea) => {
      // Type/position filter
      if (effectiveFilter !== "all") {
        if (effectiveFilter === "buy" && idea.type === "sell") return false;
        if (effectiveFilter === "sell" && idea.type !== "sell") return false;
        if (["QB", "RB", "WR", "TE"].includes(effectiveFilter) && idea.targetPlayer.position !== effectiveFilter) return false;
      }
      
      // Acceptance likelihood filter
      if (idea.acceptanceLikelihood < minAcceptance) return false;
      
      // Composite score filter
      if (idea.compositeScore !== undefined && idea.compositeScore < minScore) return false;
      
      return true;
    }).slice(0, 15);
  }, [recommendations, effectiveFilter, minAcceptance, minScore]);

  const emptyState = filteredRecs.length === 0
    ? getRecommendationEmptyState({
        candidateCount: recommendationResult.candidateCount,
        evaluatedCount: evaluatedRecommendations.length,
        rankedCount: recommendations.length,
        focusedPosition,
      })
    : null;

  const handleEmptyStateAction = () => {
    if (!emptyState) return;
    if (emptyState.action === "clear-filters") {
      setMinAcceptance(0);
      setMinScore(0);
      selectFilter("all");
      return;
    }
    router.push(emptyState.action === "player-values" ? "/values" : "/trade");
  };

  const sellHighCount = recommendations.filter((r) => r.type === "sell").length;
  const buyCount = recommendations.filter((r) => r.type !== "sell").length;

  const strategicPlan = useMemo(() => buildStrategicPlan({
    recommendations: planRecommendations, myRoster, leagueSettings, personalValues, rosters, myTeamId,
    projectionAdjustedValues: projAdjValues, getPlayerValue,
  }), [planRecommendations, myRoster, leagueSettings, personalValues, rosters, myTeamId, projAdjValues, getPlayerValue]);

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight gradient-text">Trade Finder</h1>
        <p className="text-muted-foreground mt-2 text-base sm:text-lg">
          {leagueSettings?.mode === "redraft"
            ? "Current-season trade recommendations based on projected lineup gain, roster needs, and market value"
            : "AI-powered trade recommendations based on roster needs, value gaps, and league dynamics"}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 sm:gap-6 text-xs sm:text-sm">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${statsError ? "bg-orange-500" : statsLoading ? "bg-yellow-500 animate-pulse" : Object.keys(playerStats).length > 0 ? "bg-green-500" : "bg-muted-foreground"}`}></div>
            <span className="text-muted-foreground">
              {statsError
                ? Object.keys(playerStats).length > 0
                  ? "Stats refresh failed — using cached season form"
                  : "Season form unavailable — using market estimates"
                : statsLoading
                  ? "Loading season form…"
                  : Object.keys(playerStats).length > 0
                    ? "Season form included"
                    : "Using market estimates"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500"></div>
            <span className="text-muted-foreground"><span className="font-semibold text-foreground">Opponent fit</span> = Heuristic score based on value, needs, and team window—not a probability</span>
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
              {leagueSettings?.mode !== "redraft" && (
                <span className="text-muted-foreground">Age {strategicPlan.teamSummary.avgAge.toFixed(1)}</span>
              )}
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                strategicPlan.teamSummary.dynastyPowerScore >= 65 ? "bg-green-500/10 text-green-400 border-green-500/30" :
                strategicPlan.teamSummary.dynastyPowerScore >= 40 ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30" :
                "bg-red-500/10 text-red-400 border-red-500/30"
              }`}>
                {leagueSettings?.mode === "redraft" ? "Season" : "Dynasty"} ⚡ {strategicPlan.teamSummary.dynastyPowerScore}
              </span>
              {leagueSettings?.mode !== "redraft" && <span className={`text-xs font-medium ${
                strategicPlan.teamSummary.pickSurplusLabel === "surplus" ? "text-green-400" :
                strategicPlan.teamSummary.pickSurplusLabel === "deficit" ? "text-red-400" :
                "text-muted-foreground"
              }`}>
                Picks: {strategicPlan.teamSummary.pickSurplusLabel}
              </span>}
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
                              {Math.round(step.trade.acceptanceLikelihood)}/100 opponent fit
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
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5" />
              Positional Needs
            </div>
            <select
              value={needsTeamId}
              onChange={(e) => setNeedsTeamId(e.target.value)}
              className="text-xs px-2 py-1 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 font-normal"
            >
              <option value="mine">Your Team</option>
              {rosters.map((r) => (
                <option key={r.teamId} value={r.teamId}>
                  {r.teamName || `Team ${r.teamId}`} {r.teamId === myTeamId ? "(You)" : ""}
                </option>
              ))}
            </select>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(() => {
            const selectedRoster = needsTeamId === "mine"
              ? myRoster
              : rosters.find((r) => r.teamId === needsTeamId);
            if (!selectedRoster) return null;
            const selectedNeeds = calculatePositionalNeed(
              selectedRoster.players,
              leagueSettings?.rosterSlots || [],
              leagueSettings?.superflex || false,
              needsTeamId === "mine" ? personalValues : {}
            );
            return (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {Object.entries(selectedNeeds).map(([pos, need]) => (
                  <div key={pos} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className={positionColors[pos] || ""}>{pos}</Badge>
                      <span className={`text-xs font-medium ${need > 40 ? "text-red-400" : need > 20 ? "text-yellow-400" : need > 8 ? "text-blue-400" : "text-green-400"}`}>
                        {need > 40 ? "High Need" : need > 20 ? "Moderate" : need > 8 ? "Solid" : "Elite"}
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
            );
          })()}
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardContent className="py-4 space-y-4">
          {focusedPosition && (
            <div className="flex flex-col gap-2 rounded-lg border border-primary/25 bg-primary/5 p-3 sm:flex-row sm:items-center">
              <div className="flex-1">
                <p className="text-sm font-semibold text-primary">Focused on {focusedPosition} upgrades</p>
                <p className="text-xs text-muted-foreground">
                  Showing acquisition ideas for the roster need identified in your League Hub.
                </p>
              </div>
              <button
                type="button"
                onClick={() => selectFilter("all")}
                className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground sm:self-auto"
              >
                <X className="h-3.5 w-3.5" />
                Show all ideas
              </button>
            </div>
          )}

          {/* Filter tabs */}
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="h-4 w-4 text-muted-foreground" />
            {(["all", "buy", "sell", "QB", "RB", "WR", "TE"] as FilterType[]).map((f) => (
              <button
                key={f}
                onClick={() => selectFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  effectiveFilter === f
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
              {minAcceptance > 0 && <span className="bg-muted px-2 py-1 rounded">≥{minAcceptance} opponent fit</span>}
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
            <h2 className="text-lg font-semibold mb-2">{emptyState?.title}</h2>
            <p className="text-muted-foreground text-center max-w-md text-sm">
              {emptyState?.description}
            </p>
            {emptyState && (
              <button
                type="button"
                onClick={handleEmptyStateAction}
                className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {emptyState.actionLabel}
              </button>
            )}
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
                      {idea.scoreFactors && (
                        <RecommendationFactors
                          valueGain={idea.scoreFactors.valueGain}
                          positionalFit={idea.scoreFactors.positionalFit}
                          windowAlignment={idea.scoreFactors.windowAlignment}
                          opponentFit={idea.scoreFactors.acceptanceLikelihood}
                          lineupPoints={idea.evalResult?.lineupImpactA?.pointsGained}
                          lineupSource={idea.evalResult?.lineupImpactA?.source}
                        />
                      )}
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
                                  {Math.round(idea.acceptanceLikelihood)}/100
                                </p>
                                <p className="text-[10px] text-muted-foreground leading-tight uppercase tracking-wide">Opponent fit</p>
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
                            <p className="font-semibold mb-1">Opponent Offer Fit</p>
                            <p className="text-xs">Heuristic offer fit for {idea.targetTeamName}; not an acceptance probability</p>
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
                                <span className={`font-medium ${acceptLabel(option.acceptance)}`}>{Math.round(option.acceptance)}/100</span>
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
