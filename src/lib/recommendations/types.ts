import type { Player } from "../../types/index.ts";
import type { ScoringFactors } from "../recommendation-scoring.ts";
import type { SmartTradeResult } from "../trade-engine.ts";

export type TradeType = "buy" | "sell" | "upgrade" | "2for1" | "buy-low" | "pick";
export type PositionFilter = "QB" | "RB" | "WR" | "TE";

export interface RecommendationPick {
  year: number;
  round: number;
  estimatedValue: number;
}

export interface TradeIdea {
  type: TradeType;
  targetPlayer: Player;
  targetTeamId: string;
  targetTeamName: string;
  offeredPlayers: Player[];
  offeredPicks?: RecommendationPick[];
  receivingPicks?: RecommendationPick[];
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
    evalResult?: SmartTradeResult;
  }>;
  roadmap?: string[];
  compositeScore?: number;
  scoreExplanation?: string;
  scoreFactors?: ScoringFactors;
  evalResult?: SmartTradeResult;
}

export interface PlanStep {
  phase: number;
  type: "buy" | "sell" | "hold";
  trade?: TradeIdea;
  headline: string;
  context: string;
  needsBefore: Record<string, number>;
  needsAfter?: Record<string, number>;
}

export interface StrategicPlan {
  teamSummary: {
    window: string;
    windowColor: string;
    rank: number;
    avgAge: number;
    strengths: string[];
    weaknesses: string[];
    positionRanks: Record<string, number>;
    dynastyPowerScore: number;
    pickSurplusLabel: "surplus" | "normal" | "deficit";
    pickCapital: number;
    totalTeams: number;
  };
  windowStrategy: string;
  steps: PlanStep[];
}
