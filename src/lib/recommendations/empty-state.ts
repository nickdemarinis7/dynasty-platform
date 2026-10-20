export type RecommendationEmptyAction = "clear-filters" | "trade-simulator" | "player-values";

export interface RecommendationEmptyState {
  reason: "focused-position" | "no-candidates" | "quality-safeguards" | "active-filters";
  title: string;
  description: string;
  action: RecommendationEmptyAction;
  actionLabel: string;
}

interface RecommendationEmptyStateInput {
  candidateCount: number;
  evaluatedCount: number;
  rankedCount: number;
  focusedPosition: string | null;
}

export function getRecommendationEmptyState({
  candidateCount,
  evaluatedCount,
  rankedCount,
  focusedPosition,
}: RecommendationEmptyStateInput): RecommendationEmptyState {
  if (focusedPosition && rankedCount === 0) {
    return {
      reason: "focused-position",
      title: `No ${focusedPosition} upgrades passed the safeguards`,
      description: `We found no fair ${focusedPosition} deal that also improves your lineup and fits the other manager's needs. Build a custom offer to explore a specific target.`,
      action: "trade-simulator",
      actionLabel: "Open Trade Simulator",
    };
  }

  if (candidateCount === 0) {
    return {
      reason: "no-candidates",
      title: "No viable trade packages found",
      description: "Your available assets and other teams' needs do not currently produce a sensible starting package. Adjust your player values to surface opportunities the market may be missing.",
      action: "player-values",
      actionLabel: "Review Player Values",
    };
  }

  if (evaluatedCount === 0) {
    return {
      reason: "quality-safeguards",
      title: "Candidate trades failed the quality checks",
      description: `${candidateCount} potential ${candidateCount === 1 ? "package was" : "packages were"} considered, but none cleared the fairness, lineup-impact, and opponent-fit safeguards. Try a custom offer if you want to relax those assumptions.`,
      action: "trade-simulator",
      actionLabel: "Open Trade Simulator",
    };
  }

  return {
    reason: "active-filters",
    title: "Filters are hiding your recommendations",
    description: `${rankedCount} ${rankedCount === 1 ? "recommendation is" : "recommendations are"} available. Clear the category and quality thresholds to see them.`,
    action: "clear-filters",
    actionLabel: "Clear All Filters",
  };
}
