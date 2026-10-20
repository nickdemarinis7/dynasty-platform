import type { PositionFilter, TradeIdea } from "./types.ts";

export interface RecommendationRankingOptions {
  focusedPosition?: PositionFilter | null;
  limit?: number;
  maxSellsPerPlayer?: number;
}

export function rankRecommendations(
  ideas: TradeIdea[],
  options: RecommendationRankingOptions = {},
): TradeIdea[] {
  const {
    focusedPosition = null,
    limit = 15,
    maxSellsPerPlayer = 2,
  } = options;
  const seenTargets = new Set<string>();
  const sellCountByPlayer = new Map<string, number>();

  return [...ideas]
    .sort((a, b) => {
      const scoreDifference = (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
      return scoreDifference || b.acceptanceLikelihood - a.acceptanceLikelihood;
    })
    .filter((idea) => {
      if (focusedPosition && (idea.type === "sell" || idea.targetPlayer.position !== focusedPosition)) {
        return false;
      }

      const targetKey = `${idea.targetPlayer.id}-${idea.targetTeamId}`;
      if (seenTargets.has(targetKey)) return false;
      seenTargets.add(targetKey);

      if (idea.type !== "sell") return true;
      const soldId = idea.offeredPlayers[0]?.id ?? idea.targetPlayer.id;
      const count = sellCountByPlayer.get(soldId) ?? 0;
      if (count >= maxSellsPerPlayer) return false;
      sellCountByPlayer.set(soldId, count + 1);
      return true;
    })
    .slice(0, limit);
}
