export interface Player {
  id: string;
  name: string;
  position: "QB" | "RB" | "WR" | "TE" | "K" | "DEF";
  team: string;
  age: number;
  dynastyValue: number; // Base dynasty value (0-100 scale, normalized from FantasyCalc at import)
  personalValue?: number; // User's custom value override
  byeWeek?: number;
  injuryStatus?: string;
}

export interface RosterSlot {
  type: "QB" | "RB" | "WR" | "TE" | "FLEX" | "SUPERFLEX" | "K" | "DEF" | "BN" | "IR";
  count: number;
}

export type LeagueMode = "dynasty" | "keeper" | "redraft";

export interface LeagueSettings {
  id: string;
  name: string;
  platform: "sleeper" | "espn" | "yahoo" | "manual";
  mode: LeagueMode;
  teamCount: number;
  rosterSlots: RosterSlot[];
  scoringType: "ppr" | "half_ppr" | "standard";
  tePremium: boolean;
  tePremiumBonus: number; // Extra PPR for TEs
  superflex: boolean;
  taxiSquadSlots: number;
  irSlots: number;
}

export interface TeamRoster {
  teamId: string;
  teamName: string;
  ownerName: string;
  players: Player[];
  draftPicks: DraftPick[];
}

export interface DraftPick {
  year: number;
  round: number;
  originalOwner: string;
  currentOwner: string;
  estimatedValue: number;
}

export interface TradePattern {
  positionSwap: string;
  avgValueDiff: number;
  count: number;
  avgAgeDiff: number;
  confidence: number;
}

export interface TeamTradingStyle {
  teamId: string;
  teamName: string;
  totalTrades: number;
  preferredPositionsToAcquire: string[];
  preferredPositionsToTradeAway: string[];
  avgValueSent: number;
  avgValueReceived: number;
  winNowTendency: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface HistoricalTradeAnalysis {
  patterns: TradePattern[];
  teamStyles: Record<string, TeamTradingStyle>;
  avgValueDiffForAcceptedTrades: number;
  mostCommonTradeTypes: string[];
}

export interface TradePackage {
  teamA: {
    teamId: string;
    players: Player[];
    draftPicks: DraftPick[];
  };
  teamB: {
    teamId: string;
    players: Player[];
    draftPicks: DraftPick[];
  };
}

export interface TradeAnalysis {
  fairnessScore: number; // -100 to 100 (0 = perfectly fair)
  teamAValue: number;
  teamBValue: number;
  teamAPositionalNeed: Record<string, number>;
  teamBPositionalNeed: Record<string, number>;
  recommendation: "strong_accept" | "accept" | "fair" | "decline" | "strong_decline";
  reasoning: string[];
}

export interface SleeperUser {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string;
  metadata?: {
    team_name?: string;
    [key: string]: unknown;
  };
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season?: string;
  total_rosters: number;
  roster_positions: string[];
  scoring_settings: Record<string, number>;
  settings: Record<string, number>;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  players: string[];
  starters: string[];
}

export interface PlayerSeasonStats {
  gp: number;           // games played
  pts_half_ppr: number;
  pts_ppr: number;
  tgt: number;
  rec: number;
  rec_yd: number;
  rec_td: number;
  rec_air_yd: number;
  rec_yac: number;
  rush_att: number;
  rush_yd: number;
  rush_td: number;
  pass_att: number;
  pass_cmp: number;
  pass_yd: number;
  pass_td: number;
  pass_int: number;
  off_snp: number;
  tm_off_snp: number;
  rz_tgt: number;
  rz_rush_att: number;
}

export type TrajectoryLabel = "RISING" | "PEAK" | "DECLINING" | "REBUILDING";

export interface PlayerProjection {
  playerId: string;
  currentValue: number;
  projectedValue1yr: number;
  projectedValue3yr: number;
  valueDelta1yr: number;       // fractional change (-1 to +1)
  trajectoryLabel: TrajectoryLabel;
  productionScore: number;     // 0-100 vs position average
  teamFitScore: number;        // 0-100 role/opportunity quality
  edgeScore: number;           // 0-100 composite
  edgeDelta: number;           // edgeScore minus normalised market score
  fppg?: number;               // fantasy points per game (if stats available)
  targetShare?: number;        // 0-1 fraction
  rushShare?: number;          // 0-1 fraction
  signals: string[];
  recommendation: "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL";
}

export interface SleeperPlayerData {
  [playerId: string]: {
    player_id: string;
    first_name: string;
    last_name: string;
    position: string;
    team: string;
    age: number;
    fantasy_positions: string[];
  };
}

// Manager Activity Tracking
export interface ManagerActivity {
  teamId: string;
  lastLogin?: number;  // timestamp (ms)
  tradesCompleted: number;
  tradesProposed: number;
  tradesReceived: number;
  tradesAccepted: number;
  tradesRejected: number;
  responseRate: number;  // 0-1 (% of offers they respond to)
  avgResponseTime?: number;  // hours
  isActive: boolean;  // active in last 30 days
}

// Recent Trade History
export interface RecentTrade {
  timestamp: number;
  weekNumber: number;
  teamAId: string;
  teamBId: string;
  teamAPlayers: string[];  // player IDs
  teamBPlayers: string[];
  teamAPicks: { year: number; round: number }[];
  teamBPicks: { year: number; round: number }[];
}

// League Trade Velocity
export interface LeagueTradeVelocity {
  tradesPerWeek: number;
  tradesLast30Days: number;
  tradesThisSeason: number;
  avgValueDiff: number;  // how lopsided are accepted trades?
  mostActiveManagers: string[];  // team IDs
  leastActiveManagers: string[];
  leagueActivityLevel: "very_active" | "active" | "moderate" | "slow" | "dead";
}

// Trade Block (from Sleeper API)
export interface TradeBlock {
  teamId: string;
  playerIds: string[];
  note?: string;
  updatedAt?: number;
}

// Enhanced Player with injury/status
export interface EnhancedPlayer extends Player {
  injuryStatus?: "active" | "questionable" | "doubtful" | "out" | "ir" | "suspended";
  weeksMissed?: number;
  expectedReturn?: number;  // week number
}
