import {
  calculatePositionalFit,
  calculateUrgency,
  calculateWindowAlignment,
  scoreRecommendation,
} from "../recommendation-scoring.ts";
import type { TeamContext } from "../trade-engine.ts";
import type { LeagueMode } from "../../types/index.ts";
import { filterQualityRecommendations } from "./quality.ts";
import type { TradeIdea } from "./types.ts";

export interface RecommendationPipelineContext {
  needs: Record<string, number>;
  myTeam: TeamContext;
  league: Map<string, TeamContext>;
  mode: LeagueMode;
}

export function hasUsefulLineupImpact(idea: TradeIdea): boolean {
  if (idea.type === "sell") return true;
  const impact = idea.evalResult?.lineupImpactA;
  if (!impact) return true;
  if (impact.recommendation === "strong_downgrade" || impact.recommendation === "downgrade") {
    return false;
  }
  if (impact.pointsGained < 1 && !impact.receivedPlayerStarts) {
    return idea.type === "2for1" && impact.pointsGained >= 2;
  }
  return true;
}

export function scoreTradeIdea(
  idea: TradeIdea,
  context: RecommendationPipelineContext,
): TradeIdea {
  const targetNeed = context.needs[idea.targetPlayer.position] ?? 0;
  const positionalFit = calculatePositionalFit(
    idea.targetPlayer.position,
    context.needs,
    idea.offeredPlayers[0]?.position,
  );
  const otherTeam = context.league.get(idea.targetTeamId);
  const tradeType = idea.type === "sell" ? "sell" : idea.type === "upgrade" ? "swap" : "buy";
  const windowAlignment = context.mode === "redraft"
    ? 50
    : otherTeam
    ? calculateWindowAlignment(context.myTeam, otherTeam, tradeType)
    : 50;
  const urgency = calculateUrgency(
    targetNeed,
    context.myTeam.leagueRank,
    context.myTeam.totalTeams,
    idea.type === "sell" && idea.priority === "high",
  );
  const valueGain = idea.evalResult?.marketFairness
    ?? (idea.type === "sell" ? idea.valueDiff : -idea.valueDiff);
  const score = scoreRecommendation({
    valueGain,
    positionalFit,
    acceptanceLikelihood: idea.acceptanceLikelihood,
    windowAlignment,
    urgency,
  }, context.mode);

  return {
    ...idea,
    compositeScore: score.compositeScore,
    scoreExplanation: score.explanation,
    scoreFactors: score.factors,
  };
}

export function evaluateRecommendationCandidates(
  ideas: TradeIdea[],
  context: RecommendationPipelineContext,
): TradeIdea[] {
  const scored = ideas
    .filter(hasUsefulLineupImpact)
    .map((idea) => scoreTradeIdea(idea, context));
  return filterQualityRecommendations(scored);
}
