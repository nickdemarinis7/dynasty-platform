import { shouldFilterOut, type ScoredRecommendation } from "../recommendation-scoring.ts";
import type { TradeIdea } from "./types.ts";

export function isQualityRecommendation(idea: TradeIdea): boolean {
  if (
    idea.compositeScore === undefined ||
    !idea.scoreFactors ||
    !idea.scoreExplanation
  ) {
    return false;
  }

  const scored: ScoredRecommendation = {
    compositeScore: idea.compositeScore,
    factors: idea.scoreFactors,
    explanation: idea.scoreExplanation,
  };
  if (shouldFilterOut(scored)) return false;

  // Low-fit overpays are not useful acquisition suggestions. Sell ideas remain
  // eligible because the goal there is to exit a declining asset.
  if (
    idea.type !== "sell" &&
    idea.acceptanceLikelihood < 35 &&
    idea.scoreFactors.valueGain < 0
  ) {
    return false;
  }

  return true;
}

export function filterQualityRecommendations(ideas: TradeIdea[]): TradeIdea[] {
  return ideas.filter(isQualityRecommendation);
}
