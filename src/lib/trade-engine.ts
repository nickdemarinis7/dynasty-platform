import type { Player, TeamRoster, LeagueSettings, DraftPick } from "../types/index.ts";
import { getPlayerValue, calculatePositionalNeed } from "./player-values.ts";
import { evaluateTradeLineupImpact } from "./lineup-optimizer.ts";
import type { PlayerProjection } from "./projections-api.ts";

// ============================================================================
// Asset time profiles — how an asset's value splits between "win now" (next
// 1-2 seasons) and "future" (years 3-5). Built from position-specific aging
// curves. Factors are centered around 1.0 so a prime, every-down asset is ~1.0
// on both axes and the blend stays comparable to raw market value.
// ============================================================================

interface PositionCurve {
  peakStart: number;
  peakEnd: number;
  // value retained per year past peakEnd (decline), and per year before
  // peakStart we treat as "ascending" (future-heavy)
  declinePerYear: number;
  // how long the productive shelf is (affects future factor for young players)
  shelfYears: number;
}

const POSITION_CURVES: Record<string, PositionCurve> = {
  QB: { peakStart: 26, peakEnd: 33, declinePerYear: 0.06, shelfYears: 12 },
  RB: { peakStart: 23, peakEnd: 27, declinePerYear: 0.14, shelfYears: 5 },
  WR: { peakStart: 24, peakEnd: 27, declinePerYear: 0.10, shelfYears: 8 },
  TE: { peakStart: 25, peakEnd: 30, declinePerYear: 0.08, shelfYears: 9 },
};

export interface TimeProfile {
  nowFactor: number; // production weight over next 1-2 years
  futureFactor: number; // value weight over years 3-5
}

/**
 * Returns a player's time profile. Young players are future-heavy, players at
 * peak are now-heavy and balanced, aging players are now-only with collapsing
 * future value.
 */
export function getAssetTimeProfile(position: string, age: number): TimeProfile {
  const curve = POSITION_CURVES[position];
  if (!curve || !age || age <= 0) {
    return { nowFactor: 1, futureFactor: 1 };
  }

  const { peakStart, peakEnd, declinePerYear, shelfYears } = curve;

  let nowFactor: number;
  let futureFactor: number;

  if (age < peakStart) {
    // Ascending: not yet at peak. Slightly lower now, higher future.
    const yearsToPeak = peakStart - age;
    nowFactor = Math.max(0.65, 1 - yearsToPeak * 0.08);
    futureFactor = Math.min(1.45, 1 + yearsToPeak * 0.12);
  } else if (age <= peakEnd) {
    // In prime window.
    nowFactor = 1.15;
    const yearsOfShelfLeft = peakEnd - age + shelfYears * 0.4;
    futureFactor = Math.max(0.6, Math.min(1.1, 0.6 + yearsOfShelfLeft * 0.06));
  } else {
    // Declining.
    const yearsPast = age - peakEnd;
    nowFactor = Math.max(0.55, 1.1 - yearsPast * 0.07);
    futureFactor = Math.max(0.15, 1 - yearsPast * declinePerYear * 3.2);
  }

  return { nowFactor, futureFactor };
}

// Draft picks are pure future assets — low immediate, high future.
const PICK_TIME_PROFILE: TimeProfile = { nowFactor: 0.5, futureFactor: 1.35 };

// ============================================================================
// League context — the whole-league landscape. For each team we compute a
// contention score combining roster strength (rank in league) and age profile,
// plus positional needs/surplus.
// ============================================================================

export interface TeamContext {
  teamId: string;
  teamName: string;
  totalValue: number;
  starterValue: number;
  leagueRank: number;            // 1 = strongest roster by starter value
  avgAge: number;
  contentionScore: number;       // -1 (full rebuild) .. +1 (full win-now)
  winNowWeight: number;          // 0..1 used to blend now/future asset value
  windowLabel: string;
  windowColor: string;
  positionNeeds: Record<string, number>;          // 0-100 (higher = more need)
  // === Dynasty intelligence ===
  pickCount: number;             // total draft picks owned
  pickCapital: number;           // sum of estimatedValue across owned picks
  pickSurplusLabel: "surplus" | "normal" | "deficit"; // relative to league avg
  relativePositionRanks: Record<string, number>;  // 1 = best in league at that position
  deadZonePlayerIds: string[];   // aging players with moderate value — prime jettison targets
  anchorPlayerIds: string[];     // untouchable: young elite SF QBs, top franchise pieces
  dynastyPowerScore: number;     // 0-100: current strength + age trajectory + pick capital
  rosterTopHeaviness: number;    // top-3 value / total value (higher = star-dependent)
  totalTeams: number;            // league size (for "rank X of Y" displays)
}

const WINDOW_LABELS: { min: number; label: string; color: string }[] = [
  { min: 0.62, label: "Win Now", color: "text-yellow-400" },
  { min: 0.42, label: "Competing", color: "text-green-400" },
  { min: 0.3, label: "Balanced", color: "text-gray-400" },
  { min: 0.18, label: "Young Core", color: "text-cyan-400" },
  { min: -1, label: "Rebuilding", color: "text-blue-400" },
];

function labelForWeight(w: number) {
  return WINDOW_LABELS.find((l) => w >= l.min) ?? WINDOW_LABELS[WINDOW_LABELS.length - 1];
}

/**
 * Estimates a roster's starter value by filling the league's starting slots
 * with the best available players at each position (incl. FLEX/SUPERFLEX).
 */
function computeStarterValue(
  roster: Player[],
  leagueSettings: LeagueSettings,
  value: (p: Player) => number
): number {
  // Clone and sort each position group (non-destructive)
  const byPos: Record<string, Player[]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const p of roster) {
    if (byPos[p.position]) byPos[p.position].push(p);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => value(b) - value(a));
  }

  // Track how many we've used from each position via index (no mutation)
  const taken: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const usedIds = new Set<string>();
  let total = 0;

  // Fill mandatory position slots first
  for (const slot of leagueSettings.rosterSlots) {
    if (!byPos[slot.type]) continue; // skip FLEX/SUPERFLEX here
    const n = slot.count;
    for (let i = 0; i < n; i++) {
      const idx = taken[slot.type];
      if (idx < byPos[slot.type].length) {
        const p = byPos[slot.type][idx];
        total += value(p);
        usedIds.add(p.id);
        taken[slot.type]++;
      }
    }
  }

  // Build flex pool: remaining RB/WR/TE not yet started
  const flexPool: Player[] = [];
  for (const pos of ["RB", "WR", "TE"]) {
    for (let i = taken[pos]; i < byPos[pos].length; i++) {
      flexPool.push(byPos[pos][i]);
    }
  }
  flexPool.sort((a, b) => value(b) - value(a));

  const flexCount =
    leagueSettings.rosterSlots.find((s) => s.type === "FLEX")?.count ?? 0;
  for (let i = 0; i < Math.min(flexCount, flexPool.length); i++) {
    total += value(flexPool[i]);
    usedIds.add(flexPool[i].id);
  }

  // Superflex: remaining QB/RB/WR/TE not yet used, including bench QBs
  const sfCount =
    leagueSettings.rosterSlots.find((s) => s.type === "SUPERFLEX")?.count ?? 0;
  if (sfCount > 0) {
    const sfPool: Player[] = [];
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      for (const p of byPos[pos]) {
        if (!usedIds.has(p.id)) sfPool.push(p);
      }
    }
    sfPool.sort((a, b) => value(b) - value(a));
    for (let i = 0; i < Math.min(sfCount, sfPool.length); i++) {
      total += value(sfPool[i]);
      usedIds.add(sfPool[i].id);
    }
  }

  return total;
}

// Age at which each position enters the "dead zone" — actively losing dynasty value
// while still holding enough market price to be tradeable.
const DEAD_ZONE_CLIFF: Record<string, number> = { RB: 27, WR: 29, TE: 29, QB: 33 };

export function buildLeagueContext(
  rosters: TeamRoster[],
  leagueSettings: LeagueSettings,
  personalValues: Record<string, number>
): Map<string, TeamContext> {
  const value = (p: Player) => getPlayerValue(p, personalValues);

  // First pass: raw metrics per team
  const raw = rosters.map((r) => {
    const players = r.players;
    const total = players.reduce((s, p) => s + value(p), 0);
    const starter = computeStarterValue(players, leagueSettings, value);
    const skill = players.filter(
      (p) => p.age > 0 && ["QB", "RB", "WR", "TE"].includes(p.position)
    );
    // Value-weighted average age (your best players' ages matter most)
    const wsum = skill.reduce((s, p) => s + value(p), 0) || 1;
    const avgAge = skill.reduce((s, p) => s + p.age * value(p), 0) / wsum || 0;

    // Pick capital
    const picks = r.draftPicks ?? [];
    const pickCount = picks.length;
    const pickCapital = picks.reduce((s, pk) => s + (pk.estimatedValue ?? 0), 0);

    // Positional value totals for relative ranking
    const posTotals: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const p of players) {
      if (posTotals[p.position] !== undefined) posTotals[p.position] += value(p);
    }

    // Roster top-heaviness: how dependent is this team on 1-2 stars?
    const sortedByVal = [...players].sort((a, b) => value(b) - value(a));
    const top3Value = sortedByVal.slice(0, 3).reduce((s, p) => s + value(p), 0);
    const rosterTopHeaviness = total > 0 ? top3Value / total : 0;

    return { roster: r, total, starter, avgAge, pickCount, pickCapital, posTotals, rosterTopHeaviness };
  });

  const teams = raw.length;
  const leagueAvgAge = raw.reduce((s, x) => s + x.avgAge, 0) / (raw.length || 1);
  const leagueAvgPickCapital = raw.reduce((s, x) => s + x.pickCapital, 0) / (raw.length || 1);
  const maxPickCapital = Math.max(...raw.map((x) => x.pickCapital), 1);

  // Rank by starter value (1 = strongest)
  const byStarter = [...raw].sort((a, b) => b.starter - a.starter);
  const rankMap = new Map<string, number>();
  byStarter.forEach((x, i) => rankMap.set(x.roster.teamId, i + 1));

  // Relative position ranks: rank each team 1-N at each position by positional value
  const relPosRanksMap = new Map<string, Record<string, number>>();
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const sorted = [...raw].sort((a, b) => (b.posTotals[pos] ?? 0) - (a.posTotals[pos] ?? 0));
    sorted.forEach((x, i) => {
      const existing = relPosRanksMap.get(x.roster.teamId) ?? {};
      existing[pos] = i + 1;
      relPosRanksMap.set(x.roster.teamId, existing);
    });
  }

  const ctxMap = new Map<string, TeamContext>();

  for (const x of raw) {
    const isRedraft = leagueSettings.mode === "redraft";
    const rank = rankMap.get(x.roster.teamId)!;
    // Strength component: +1 best roster, -1 worst.
    const strengthComp = teams > 1 ? 1 - (2 * (rank - 1)) / (teams - 1) : 0;
    // Age component: older than league = more win-now urgency.
    const ageComp = Math.max(-1, Math.min(1, (x.avgAge - leagueAvgAge) / 3));

    // Contention: mostly strength, modulated by age.
    let contentionScore = isRedraft ? strengthComp : 0.62 * strengthComp + 0.38 * ageComp;
    contentionScore = Math.max(-1, Math.min(1, contentionScore));
    const winNowWeight = isRedraft
      ? 1
      : Math.max(0.12, Math.min(0.88, (contentionScore + 1) / 2));

    const lbl = labelForWeight(winNowWeight);
    const positionNeeds = calculatePositionalNeed(
      x.roster.players,
      leagueSettings.rosterSlots,
      leagueSettings.superflex,
      personalValues
    );

    // Pick surplus/deficit relative to league average
    const pickSurplusLabel: "surplus" | "normal" | "deficit" =
      x.pickCapital > leagueAvgPickCapital * 1.4 ? "surplus" :
      x.pickCapital < leagueAvgPickCapital * 0.55 ? "deficit" : "normal";

    // Dead zone assets: aging players in the moderate-value range losing value fast
    const deadZonePlayerIds = x.roster.players
      .filter((p) => {
        if (isRedraft) return false;
        const cliff = DEAD_ZONE_CLIFF[p.position];
        if (!cliff) return false;
        const v = value(p);
        const profile = getAssetTimeProfile(p.position, p.age);
        return p.age >= cliff && v >= 18 && v <= 62 && profile.futureFactor < 0.72;
      })
      .map((p) => p.id);

    // Anchor assets: untouchable players — never recommend trading these
    const anchorPlayerIds = x.roster.players
      .filter((p) => {
        const v = value(p);
        // Young elite SF QB: dynasty cornerstone, irreplaceable
        if (leagueSettings.superflex && p.position === "QB" && p.age <= 27 && v >= 55) return true;
        // Top overall franchise piece: the team's single best asset at 75+ value
        const teamMax = x.roster.players.reduce((m, pl) => Math.max(m, value(pl)), 0);
        if (v >= teamMax && v >= 75) return true;
        return false;
      })
      .map((p) => p.id);

    // Redraft measures current roster strength and balance only. Dynasty adds
    // age trajectory and future draft capital to that foundation.
    const rankScore = teams > 1
      ? ((teams - rank) / (teams - 1)) * (isRedraft ? 80 : 40)
      : (isRedraft ? 40 : 20);
    const ageScore = isRedraft ? 0 : Math.min(30, Math.max(0, (28 - x.avgAge) * 3));
    const pickScore = isRedraft ? 0 : maxPickCapital > 0 ? (x.pickCapital / maxPickCapital) * 20 : 0;
    const balanceScore = (1 - x.rosterTopHeaviness) * (isRedraft ? 20 : 10);
    const dynastyPowerScore = Math.round(Math.max(0, Math.min(100, rankScore + ageScore + pickScore + balanceScore)));

    ctxMap.set(x.roster.teamId, {
      teamId: x.roster.teamId,
      teamName: x.roster.teamName,
      totalValue: x.total,
      starterValue: x.starter,
      leagueRank: rank,
      avgAge: x.avgAge,
      contentionScore,
      winNowWeight,
      windowLabel: lbl.label,
      windowColor: lbl.color,
      positionNeeds,
      pickCount: x.pickCount,
      pickCapital: x.pickCapital,
      pickSurplusLabel,
      relativePositionRanks: relPosRanksMap.get(x.roster.teamId) ?? {},
      deadZonePlayerIds,
      anchorPlayerIds,
      dynastyPowerScore,
      rosterTopHeaviness: x.rosterTopHeaviness,
      totalTeams: teams,
    });
  }

  return ctxMap;
}

// ============================================================================
// Contextual valuation — what an asset is worth TO A SPECIFIC TEAM given its
// window (now/future blend) and positional need.
// ============================================================================

function blendForWeight(profile: TimeProfile, winNowWeight: number): number {
  return winNowWeight * profile.nowFactor + (1 - winNowWeight) * profile.futureFactor;
}

/** Need multiplier applied to assets a team RECEIVES at a position of need. */
function needMultiplier(need: number): number {
  // need 0..100 -> multiplier 1.0 .. 1.35
  return 1 + Math.max(0, Math.min(100, need)) / 100 * 0.35;
}

export interface AssetEval {
  label: string;
  position: string; // QB/RB/WR/TE or PICK
  marketValue: number;
  contextValue: number; // value to the receiving team
}

export function contextualPlayerValue(
  player: Player,
  marketValue: number,
  ctx: TeamContext,
  applyNeed: boolean
): number {
  const profile = getAssetTimeProfile(player.position, player.age);
  const blend = blendForWeight(profile, ctx.winNowWeight);
  let v = marketValue * blend;
  if (applyNeed) {
    v *= needMultiplier(ctx.positionNeeds[player.position] ?? 0);
  }
  return v;
}

export function contextualPickValue(
  pick: DraftPick,
  ctx: TeamContext
): number {
  const blend = blendForWeight(PICK_TIME_PROFILE, ctx.winNowWeight);
  return pick.estimatedValue * blend;
}

// ============================================================================
// Smart trade evaluation.
// ============================================================================

export interface SmartTradeInput {
  teamACtx: TeamContext;
  teamBCtx: TeamContext;
  // Assets moving FROM A TO B (A gives these, B receives these)
  aGivesPlayers: Player[];
  aGivesPicks: DraftPick[];
  // Assets moving FROM B TO A (B gives these, A receives these)
  bGivesPlayers: Player[];
  bGivesPicks: DraftPick[];
  personalValues: Record<string, number>;
  // Optional: for lineup impact simulation
  teamARoster?: Player[];
  teamBRoster?: Player[];
  leagueSettings?: LeagueSettings;
  projections?: Record<string, PlayerProjection>;
  lineupPointEstimates?: Record<string, number>;
  currentWeek?: number;
  isPlayoffs?: boolean;
}

export interface SmartTradeResult {
  marketA: number; // raw market value A gives up
  marketB: number; // raw market value B gives up
  marketDiff: number; // marketB - marketA (positive = A receives more)
  marketFairness: number; // -100..100, positive = favors A
  // Team-fit: change in contextual value for each team (received - given)
  fitA: number;
  fitB: number;
  fitAPct: number; // fit relative to team's roster value
  fitBPct: number;
  acceptanceLikelihood: number; // 0-100 heuristic offer-fit score for Team B
  verdictForA: { label: string; tone: "good" | "fair" | "bad" };
  reasoning: string[];
  needsAfterA: Record<string, number>;
  needsAfterB: Record<string, number>;
  // Lineup impact (if roster data available)
  lineupImpactA?: {
    pointsGained: number;
    receivedPlayerStarts: boolean;
    recommendation: "strong_upgrade" | "upgrade" | "lateral" | "downgrade" | "strong_downgrade";
    source: "weekly_projection" | "season_fppg" | "market_value_estimate";
  };
  lineupImpactB?: {
    pointsGained: number;
    receivedPlayerStarts: boolean;
    recommendation: "strong_upgrade" | "upgrade" | "lateral" | "downgrade" | "strong_downgrade";
    source: "weekly_projection" | "season_fppg" | "market_value_estimate";
  };
}

/**
 * Applies a roster-spot/consolidation discount to packages. The best asset is
 * valued in full; additional assets contribute progressively less because
 * dynasty managers generally prefer one elite asset over an equal raw sum of
 * replaceable pieces.
 */
export function packageAdjustedValue(values: number[]): number {
  return [...values]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a)
    .reduce((total, value, index) => {
      if (index === 0) return total + value;
      const multiplier = Math.max(0.75, 0.9 - (index - 1) * 0.05);
      return total + value * multiplier;
    }, 0);
}

export function evaluateTrade(input: SmartTradeInput): SmartTradeResult {
  const {
    teamACtx,
    teamBCtx,
    aGivesPlayers,
    aGivesPicks,
    bGivesPlayers,
    bGivesPicks,
    personalValues,
    teamARoster,
    teamBRoster,
    leagueSettings,
    projections,
    lineupPointEstimates,
    currentWeek,
    isPlayoffs = false,
  } = input;

  const mv = (p: Player) => getPlayerValue(p, personalValues);

  // Raw market totals (what each side gives up)
  const marketA = packageAdjustedValue([
    ...aGivesPlayers.map(mv),
    ...aGivesPicks.map((p) => p.estimatedValue),
  ]);
  const marketB = packageAdjustedValue([
    ...bGivesPlayers.map(mv),
    ...bGivesPicks.map((p) => p.estimatedValue),
  ]);

  const marketDiff = marketB - marketA; // positive = A receives more raw value
  const marketMax = Math.max(marketA, marketB, 1);
  const marketFairness = (marketDiff / marketMax) * 100;

  // Contextual value to Team A: assets A RECEIVES (from B) valued in A's window
  // with A's needs, minus assets A GIVES UP valued in A's window (no need bonus
  // on outgoing — giving from surplus is the point).
  const aReceiveVal =
    bGivesPlayers.reduce((s, p) => s + contextualPlayerValue(p, mv(p), teamACtx, true), 0) +
    bGivesPicks.reduce((s, p) => s + contextualPickValue(p, teamACtx), 0);
  const aGiveVal =
    aGivesPlayers.reduce((s, p) => s + contextualPlayerValue(p, mv(p), teamACtx, false), 0) +
    aGivesPicks.reduce((s, p) => s + contextualPickValue(p, teamACtx), 0);
  const fitA = aReceiveVal - aGiveVal;

  const bReceiveVal =
    aGivesPlayers.reduce((s, p) => s + contextualPlayerValue(p, mv(p), teamBCtx, true), 0) +
    aGivesPicks.reduce((s, p) => s + contextualPickValue(p, teamBCtx), 0);
  const bGiveVal =
    bGivesPlayers.reduce((s, p) => s + contextualPlayerValue(p, mv(p), teamBCtx, false), 0) +
    bGivesPicks.reduce((s, p) => s + contextualPickValue(p, teamBCtx), 0);
  const fitB = bReceiveVal - bGiveVal;

  const fitAPct = (fitA / Math.max(teamACtx.totalValue, 1)) * 100;
  const fitBPct = (fitB / Math.max(teamBCtx.totalValue, 1)) * 100;

  // Offer-fit score for Team B: driven by their net (market + fit). This is a
  // ranking heuristic, not a calibrated probability of acceptance.
  // Base of 15: real dynasty trade acceptance on cold offers is 5-15%.
  // Market edge weighted 60% (value matters most), fit 40% (context helps but less).
  // Fit scaled 2x (not 4x) — a 5% roster improvement shouldn't add 20 points.
  const bMarketEdge = (-marketDiff / marketMax) * 100; // positive = B gets more raw
  const bScore = 0.6 * bMarketEdge + 0.4 * fitBPct * 2;
  const acceptanceLikelihood = Math.max(0, Math.min(100, 15 + bScore));

  // Needs after trade
  const needsAfterA = computeNeedsAfter(
    teamACtx,
    aGivesPlayers,
    bGivesPlayers,
    personalValues
  );
  const needsAfterB = computeNeedsAfter(
    teamBCtx,
    bGivesPlayers,
    aGivesPlayers,
    personalValues
  );

  // Verdict for A: blend market fairness and contextual fit.
  const aCombined = 0.6 * marketFairness + 0.4 * fitAPct * 2;
  let verdictForA: SmartTradeResult["verdictForA"];
  if (aCombined > 12) verdictForA = { label: "Great for You", tone: "good" };
  else if (aCombined > 4) verdictForA = { label: "Favorable", tone: "good" };
  else if (aCombined > -4) verdictForA = { label: "Fair Trade", tone: "fair" };
  else if (aCombined > -12) verdictForA = { label: "Slightly Against You", tone: "bad" };
  else verdictForA = { label: "Poor for You", tone: "bad" };

  const reasoning = buildReasoning({
    teamACtx,
    teamBCtx,
    marketFairness,
    fitA,
    fitB,
    fitAPct,
    fitBPct,
    aGivesPlayers,
    aGivesPicks,
    bGivesPlayers,
    bGivesPicks,
    acceptanceLikelihood,
    personalValues,
  });

  // Calculate lineup impact if roster data available
  let lineupImpactA: SmartTradeResult["lineupImpactA"];
  let lineupImpactB: SmartTradeResult["lineupImpactB"];
  
  if (teamARoster && leagueSettings) {
    const impact = evaluateTradeLineupImpact(
      teamARoster,
      aGivesPlayers,
      bGivesPlayers,
      leagueSettings,
      isPlayoffs,
      currentWeek,
      projections,
      leagueSettings.scoringType === "standard" ? "std" : leagueSettings.scoringType,
      lineupPointEstimates,
    );
    lineupImpactA = {
      pointsGained: impact.pointsGained,
      receivedPlayerStarts: impact.receivedPlayerStarts,
      recommendation: impact.recommendation,
      source: projections && Object.keys(projections).length > 0
        ? "weekly_projection"
        : lineupPointEstimates && Object.keys(lineupPointEstimates).length > 0
          ? "season_fppg"
          : "market_value_estimate",
    };
  }
  
  if (teamBRoster && leagueSettings) {
    const impact = evaluateTradeLineupImpact(
      teamBRoster,
      bGivesPlayers,
      aGivesPlayers,
      leagueSettings,
      isPlayoffs,
      currentWeek,
      projections,
      leagueSettings.scoringType === "standard" ? "std" : leagueSettings.scoringType,
      lineupPointEstimates,
    );
    lineupImpactB = {
      pointsGained: impact.pointsGained,
      receivedPlayerStarts: impact.receivedPlayerStarts,
      recommendation: impact.recommendation,
      source: projections && Object.keys(projections).length > 0
        ? "weekly_projection"
        : lineupPointEstimates && Object.keys(lineupPointEstimates).length > 0
          ? "season_fppg"
          : "market_value_estimate",
    };
  }

  return {
    marketA,
    marketB,
    marketDiff,
    marketFairness,
    fitA,
    fitB,
    fitAPct,
    fitBPct,
    acceptanceLikelihood,
    verdictForA,
    reasoning,
    needsAfterA,
    needsAfterB,
    lineupImpactA,
    lineupImpactB,
  };
}

function computeNeedsAfter(
  ctx: TeamContext,
  given: Player[],
  received: Player[],
  personalValues: Record<string, number>
): Record<string, number> {
  // Scale need adjustment by player value: losing a stud (value 80+) hurts much
  // more than losing a depth piece (value 15). Impact ranges from ~5 to ~25.
  const needs = { ...ctx.positionNeeds };
  for (const p of given) {
    if (needs[p.position] !== undefined) {
      const v = getPlayerValue(p, personalValues);
      const impact = Math.max(5, Math.min(25, Math.round(v / 4)));
      needs[p.position] = Math.min(100, needs[p.position] + impact);
    }
  }
  for (const p of received) {
    if (needs[p.position] !== undefined) {
      const v = getPlayerValue(p, personalValues);
      const impact = Math.max(5, Math.min(25, Math.round(v / 4)));
      needs[p.position] = Math.max(0, needs[p.position] - impact);
    }
  }
  return needs;
}

interface ReasoningInput {
  teamACtx: TeamContext;
  teamBCtx: TeamContext;
  marketFairness: number;
  fitA: number;
  fitB: number;
  fitAPct: number;
  fitBPct: number;
  aGivesPlayers: Player[];
  aGivesPicks: DraftPick[];
  bGivesPlayers: Player[];
  bGivesPicks: DraftPick[];
  acceptanceLikelihood: number;
  personalValues: Record<string, number>;
}

function buildReasoning(i: ReasoningInput): string[] {
  const out: string[] = [];
  const mv = (p: Player) => getPlayerValue(p, i.personalValues);

  // Window framing
  out.push(
    `You (${i.teamACtx.teamName}) are **${i.teamACtx.windowLabel}** — roster #${i.teamACtx.leagueRank} in the league, avg core age ${i.teamACtx.avgAge.toFixed(1)}.`
  );
  out.push(
    `${i.teamBCtx.teamName} is **${i.teamBCtx.windowLabel}** (roster #${i.teamBCtx.leagueRank}, age ${i.teamBCtx.avgAge.toFixed(1)}).`
  );

  // Market read
  if (Math.abs(i.marketFairness) < 5) {
    out.push(`Market value is **even** (within 5%).`);
  } else if (i.marketFairness > 0) {
    out.push(`You receive **${i.marketFairness.toFixed(0)}% more** raw market value.`);
  } else {
    out.push(`You give up **${Math.abs(i.marketFairness).toFixed(0)}% more** raw market value.`);
  }

  // Timing fit for A
  const aReceives = [...i.bGivesPlayers];
  const aGivesPicks = i.aGivesPicks.length;
  const bGivesPicks = i.bGivesPicks.length;

  if (i.teamACtx.winNowWeight >= 0.55) {
    // Win-now team
    const youngIncoming = aReceives.filter((p) => getAssetTimeProfile(p.position, p.age).futureFactor > 1.15);
    if (bGivesPicks > 0) {
      out.push(`You're contending but acquiring **${bGivesPicks} pick(s)** — picks are future capital that does little for your win-now window.`);
    }
    if (aGivesPicks > 0) {
      out.push(`Moving **${aGivesPicks} pick(s)** for proven production fits your win-now timeline well.`);
    }
    if (youngIncoming.length > 0) {
      out.push(`${youngIncoming.map((p) => p.name).join(", ")} skew young/developmental — less useful for an immediate push.`);
    }
  } else if (i.teamACtx.winNowWeight <= 0.4) {
    // Rebuilder
    if (bGivesPicks > 0 || aReceives.some((p) => getAssetTimeProfile(p.position, p.age).futureFactor > 1.15)) {
      out.push(`As a rebuilder, the **youth/picks** coming back align with your timeline.`);
    }
    const agingIncoming = aReceives.filter((p) => getAssetTimeProfile(p.position, p.age).futureFactor < 0.6);
    if (agingIncoming.length > 0) {
      out.push(`${agingIncoming.map((p) => p.name).join(", ")} ${agingIncoming.length === 1 ? "is" : "are"} aging — won't be at peak when you're ready to compete.`);
    }
    if (i.aGivesPlayers.some((p) => p.age >= 28)) {
      out.push(`Selling aging veterans (${i.aGivesPlayers.filter((p) => p.age >= 28).map((p) => p.name).join(", ")}) for future value is the right move while rebuilding.`);
    }
  }

  // Positional need for A
  const needHits = i.bGivesPlayers
    .filter((p) => (i.teamACtx.positionNeeds[p.position] ?? 0) >= 35)
    .map((p) => `${p.name} (${p.position})`);
  if (needHits.length > 0) {
    out.push(`Fills a positional need: ${needHits.join(", ")}.`);
  }
  const surplusGiven = i.aGivesPlayers
    .filter((p) => {
      const need = i.teamACtx.positionNeeds[p.position] ?? 0;
      const val = mv(p);
      // "Depth" = positional need near zero AND player is below starter threshold (< 35/100).
      const isLowValue = val < 35;
      return need <= 5 && isLowValue;
    })
    .map((p) => p.name);
  if (surplusGiven.length > 0) {
    out.push(`You're dealing from depth (${surplusGiven.join(", ")}), minimizing the hit to your lineup.`);
  }

  // Best single asset framing
  const allIncoming = [...i.bGivesPlayers].sort((a, b) => mv(b) - mv(a));
  if (allIncoming.length > 0 && mv(allIncoming[0]) >= 50) {
    out.push(`You acquire a centerpiece asset in **${allIncoming[0].name}**.`);
  }

  // Acceptance read
  if (i.acceptanceLikelihood >= 65) {
    out.push(`**Strong fit for ${i.teamBCtx.teamName}** — it supports their ${i.teamBCtx.windowLabel.toLowerCase()} direction.`);
  } else if (i.acceptanceLikelihood <= 35) {
    out.push(`**Weak fit for ${i.teamBCtx.teamName}** — it does not help their ${i.teamBCtx.windowLabel.toLowerCase()} plan. Sweeten the offer.`);
  } else {
    out.push(`${i.teamBCtx.teamName} has a moderate fit — a small sweetener may improve the offer.`);
  }

  return out;
}
