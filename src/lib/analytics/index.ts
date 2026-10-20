/**
 * Public analytics boundary for application code.
 *
 * UI modules should import analytical operations from here instead of reaching
 * into individual engines. The current implementation remains local and
 * synchronous; this boundary lets us introduce a remote Python implementation
 * later without reorganizing every screen.
 */
export {
  buildLeagueContext,
  evaluateTrade,
  type SmartTradeInput,
  type SmartTradeResult,
  type TeamContext,
} from "../trade-engine";

export {
  getLineupDisplay,
  optimizeLineup,
  type OptimizedLineup,
  type TradeLineupImpact,
} from "../lineup-optimizer";

export {
  AVG_FPPG,
  computeAllProjections,
  type TeamAggregates,
} from "../projections";
