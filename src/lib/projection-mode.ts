import type { LeagueMode } from "../types/index.ts";

export interface EdgeScoreWeights {
  trajectory: number;
  production: number;
  teamFit: number;
}

export function getEdgeScoreWeights(mode: LeagueMode): EdgeScoreWeights {
  return mode === "redraft"
    ? { trajectory: 0, production: 0.6, teamFit: 0.4 }
    : { trajectory: 0.35, production: 0.35, teamFit: 0.3 };
}
