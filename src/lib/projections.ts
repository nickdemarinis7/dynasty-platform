/**
 * Proprietary projection engine.
 *
 * Three layers:
 *   Tier 1 – Age-curve trajectory (always available, no API needed)
 *   Tier 2 – Production scoring  (uses Sleeper season stats)
 *   Tier 3 – Team fit / opportunity scoring (uses team aggregates from stats)
 *
 * Combined into a composite "Edge Score" (0-100) and an "Edge Delta" that
 * compares our score to the raw FantasyCalc market value, flagging where
 * the market under- or over-prices a player.
 */

import type { Player, LeagueSettings, PlayerSeasonStats, PlayerProjection, TrajectoryLabel } from "@/types";
import { getAssetTimeProfile } from "@/lib/trade-engine";

// ============================================================================
// Tier 1 — Age-curve trajectory projections
// ============================================================================

/**
 * Projects a player's dynasty value N years forward using position aging curves.
 * Returns value on the same 0-10000 scale as dynastyValue.
 */
export function projectPlayerValue(player: Player, yearsAhead: number): number {
  const current = player.dynastyValue || 0;
  if (current === 0 || !player.age) return 0;

  const profile = getAssetTimeProfile(player.position, player.age);
  const futureProfile = getAssetTimeProfile(player.position, player.age + yearsAhead);

  // Scale current value by how nowFactor changes — captures both peak decay and
  // pre-peak growth. A young player rising toward peak gets a boost; a declining
  // player loses value proportionally to their curve.
  const nowScale = futureProfile.nowFactor / Math.max(profile.nowFactor, 0.01);

  // Future dynasty premium: young players have value beyond near-term production.
  // Blend in the futureFactor delta at a reduced weight.
  const futureDelta = (futureProfile.futureFactor - profile.futureFactor) * 0.18 * current;

  return Math.max(0, current * nowScale + futureDelta);
}

export function getTrajectoryLabel(player: Player): TrajectoryLabel {
  const current = player.dynastyValue || 0;
  if (current < 10 || !player.age) return "REBUILDING";

  const v1 = projectPlayerValue(player, 1);
  const v3 = projectPlayerValue(player, 3);
  const d1 = (v1 - current) / Math.max(current, 1);
  const d3 = (v3 - current) / Math.max(current, 1);

  if (d1 >= 0.08 || (d1 >= 0.03 && d3 >= 0.15)) return "RISING";
  if (d1 <= -0.12 || (d1 < -0.02 && d3 <= -0.25)) return "DECLINING";
  return "PEAK";
}

// ============================================================================
// Tier 2 — Production scoring vs. position average
// ============================================================================

// Half-PPR dynasty context benchmarks (FPPG for a reliable starter) — static export for reference
export const AVG_FPPG: Record<string, number> = {
  QB: 21.5,
  RB: 12.0,
  WR: 11.5,
  TE: 8.0,
};

/**
 * Format-aware FPPG benchmark: adjusts for TEP and superflex so production
 * scores are calibrated to the actual scoring environment.
 */
function getAvgFppg(position: string, settings: LeagueSettings): number {
  let avg = AVG_FPPG[position] ?? 10;
  // TEP: TEs score more points — the benchmark rises so we don't over-rate mediocre TEs
  if (position === "TE" && settings.tePremium) avg += (settings.tePremiumBonus ?? 0.5) * 4;
  // SF: QBs start in two slots — the bar is higher for what makes a "reliable starter"
  if (position === "QB" && settings.superflex) avg += 2.5;
  return avg;
}

/**
 * Calculates format-adjusted fantasy points per game from aggregated season stats.
 */
export function calcFPPG(
  stats: PlayerSeasonStats,
  position: string,
  settings: LeagueSettings
): number {
  if (!stats || stats.gp === 0) return 0;
  const ppr =
    settings.scoringType === "ppr" ? 1.0 :
    settings.scoringType === "half_ppr" ? 0.5 : 0;
  const tePrem = position === "TE" && settings.tePremium ? (settings.tePremiumBonus ?? 0.5) : 0;

  const total =
    (stats.pass_yd || 0) * 0.04 +
    (stats.pass_td || 0) * 4 -
    (stats.pass_int || 0) * 2 +
    (stats.rush_yd || 0) * 0.1 +
    (stats.rush_td || 0) * 6 +
    (stats.rec || 0) * (ppr + tePrem) +
    (stats.rec_yd || 0) * 0.1 +
    (stats.rec_td || 0) * 6;

  return total / stats.gp;
}

/**
 * 0-100 score: how well this player produces relative to position average.
 * 50 = exactly average, 100 = elite (2× avg), 0 = no production.
 */
export function computeProductionScore(
  player: Player,
  stats: PlayerSeasonStats,
  settings: LeagueSettings
): number {
  const fppg = calcFPPG(stats, player.position, settings);
  const avg = getAvgFppg(player.position, settings);
  return Math.min(100, Math.max(0, (fppg / avg) * 50));
}

// ============================================================================
// Tier 3 — Team fit / opportunity quality
// ============================================================================

export interface TeamAggregates {
  totalTgt: number;
  totalCarries: number;
  totalAirYd: number;
  totalRzTgt: number;
  totalRzCarries: number;
  totalPassAtt: number;   // sum of QB pass_att — more accurate than tgt/17
  totalPassYd: number;    // sum of rec_yd — team total passing yards (for YPA)
  passAttPerGame: number;
  rushAttPerGame: number;
  passRate: number;            // pass att / (pass + rush) — true scheme pass/run balance
  yardsPerPassAttempt: number; // team offensive efficiency (high = explosive plays)
}

/**
 * Rolls up per-player stats to NFL-team-level opportunity totals.
 * playerTeamMap: Sleeper player ID -> NFL team abbreviation
 */
export function computeTeamAggregates(
  allStats: Record<string, PlayerSeasonStats>,
  playerTeamMap: Record<string, string>
): Record<string, TeamAggregates> {
  const teams: Record<string, TeamAggregates> = {};
  for (const [playerId, stats] of Object.entries(allStats)) {
    const team = playerTeamMap[playerId];
    if (!team) continue;
    if (!teams[team]) {
      teams[team] = {
        totalTgt: 0, totalCarries: 0, totalAirYd: 0,
        totalRzTgt: 0, totalRzCarries: 0,
        totalPassAtt: 0, totalPassYd: 0,
        passAttPerGame: 0, rushAttPerGame: 0,
        passRate: 0.55, yardsPerPassAttempt: 7.0,
      };
    }
    teams[team].totalTgt += stats.tgt || 0;
    teams[team].totalCarries += stats.rush_att || 0;
    teams[team].totalAirYd += stats.rec_air_yd || 0;
    teams[team].totalRzTgt += stats.rz_tgt || 0;
    teams[team].totalRzCarries += stats.rz_rush_att || 0;
    teams[team].totalPassAtt += stats.pass_att || 0; // QBs drive this; non-QBs contribute ~0
    teams[team].totalPassYd  += stats.rec_yd  || 0;  // receiving yards = team passing yards
  }
  // Compute per-game rates assuming 17-game season
  for (const agg of Object.values(teams)) {
    // Use actual pass_att when available; fall back to target proxy
    agg.passAttPerGame = agg.totalPassAtt > 0 ? agg.totalPassAtt / 17 : agg.totalTgt / 17;
    agg.rushAttPerGame = agg.totalCarries / 17;
    // Pass rate: fraction of plays that are passes — true scheme balance signal
    const totalPlays = agg.totalPassAtt + agg.totalCarries;
    agg.passRate = totalPlays > 0 ? agg.totalPassAtt / totalPlays : 0.55;
    // YPA: offensive efficiency — high YPA = explosive plays, lifts downfield pass catchers
    agg.yardsPerPassAttempt = agg.totalPassAtt > 0 ? agg.totalPassYd / agg.totalPassAtt : 7.0;
  }
  return teams;
}

/**
 * 0-100 team fit score: how good is this player's role/opportunity on their NFL team?
 * Incorporates: target/rush share, snap share (role security), RZ targets, air yard depth,
 * and team scheme indicators (pass-heavy/run-heavy) as a formation-fit proxy.
 */
export function computeTeamFitScore(
  player: Player,
  stats: PlayerSeasonStats,
  teamAggs: Record<string, TeamAggregates>
): {
  score: number;
  targetShare?: number;
  rushShare?: number;
  airYardShare?: number;
  snapShare?: number;
  rzTargetShare?: number;
  aDOT?: number;
  alphaModifier?: number;  // role quality bonus/penalty (+20 alpha monopoly → -15 committee)
  recPerGame?: number;     // receptions per game (three-down RB detection)
  yacRate?: number;        // fraction of receiving yards gained after catch (0–1)
  yardsPerTarget?: number; // receiving yards per target (target quality signal)
  catchRate?: number;      // receptions per target (separation + hands quality)
  completionPct?: number;  // QB completion percentage
  tdRate?: number;         // QB TDs per pass attempt
  teamPassRate?: number;   // team pass rate — scheme pass/run balance signal
  teamYPA?: number;        // team yards per pass attempt — offensive efficiency
} {
  const agg = teamAggs[player.team];
  if (!agg) return { score: 50 };

  let score = 50;
  let targetShare: number | undefined;
  let rushShare: number | undefined;
  let airYardShare: number | undefined;
  let snapShare: number | undefined;
  let rzTargetShare: number | undefined;
  let aDOT: number | undefined;
  let alphaModifier = 0;
  let recPerGame: number | undefined;
  let yacRate: number | undefined;
  let yardsPerTarget: number | undefined;
  let catchRate: number | undefined;
  let completionPct: number | undefined;
  let tdRate: number | undefined;

  // Snap share — role security signal for all positions
  // off_snp / tm_off_snp is a direct measure of how locked-in a player is
  if (stats.tm_off_snp > 0) {
    snapShare = Math.min(1, (stats.off_snp || 0) / stats.tm_off_snp);
  }
  const snapScore = snapShare !== undefined
    ? Math.min(60, (snapShare / 0.75) * 60)  // 75% snap share = full score
    : 30; // default neutral when no snap data

  if (player.position === "WR" || player.position === "TE") {
    if (agg.totalTgt > 0) {
      targetShare = (stats.tgt || 0) / agg.totalTgt;
      airYardShare = agg.totalAirYd > 0 ? (stats.rec_air_yd || 0) / agg.totalAirYd : undefined;
      rzTargetShare = agg.totalRzTgt > 0 ? (stats.rz_tgt || 0) / agg.totalRzTgt : undefined;
      // Average depth of target: scheme-depth proxy (deep threat vs slot)
      aDOT = stats.tgt > 0 ? (stats.rec_air_yd || 0) / stats.tgt : undefined;

      const tgtScore = Math.min(100, (targetShare / 0.20) * 60);   // 20% tgt share = benchmark
      const ayScore = airYardShare !== undefined
        ? Math.min(100, (airYardShare / 0.22) * 50)
        : 30;
      const rzScore = rzTargetShare !== undefined
        ? Math.min(50, (rzTargetShare / 0.18) * 50)  // 18% RZ share = full TD upside
        : 25;
      // Scheme fit: pass rate is more reliable than raw attempt count
      // 50% = neutral, 70% = max bonus (+15), <40% = penalty (-5)
      const passRateBonus = Math.min(15, Math.max(-5, (agg.passRate - 0.50) / 0.20 * 15));
      // Explosive offense: high YPA lifts pass catchers, especially downfield threats
      const ypaBonus = agg.yardsPerPassAttempt >= 8.5 ? 4 :
                       agg.yardsPerPassAttempt >= 7.5 ? 1 :
                       agg.yardsPerPassAttempt < 6.5 ? -3 : 0;

      // Alpha monopoly: dominant target share is rare and dynasty-irreplaceable
      // Market systematically undervalues true alphas because FPPG comparisons mask dominance
      if (targetShare >= 0.27) alphaModifier = 22;        // monopoly alpha (≈20%+ of team targets)
      else if (targetShare >= 0.22) alphaModifier = 13;   // true WR1 workhorse
      else if (targetShare >= 0.17) alphaModifier = 6;    // reliable starter
      else if (targetShare >= 0.12) alphaModifier = 0;    // WR2 / depth TE
      else alphaModifier = -12;                           // fringe depth / pure blocker TE

      // Per-snap efficiency: targets relative to snaps played reveals hyper-targeting
      // A WR getting 25% of targets on 65% of snaps is being targeted on nearly every route
      if (snapShare !== undefined && snapShare > 0.15) {
        const tgtPerSnap = targetShare / snapShare;
        if (tgtPerSnap >= 0.38) alphaModifier += 8;       // hyper-targeted when on field
        else if (tgtPerSnap >= 0.28) alphaModifier += 3;
        else if (tgtPerSnap < 0.15) alphaModifier -= 6;   // ignored when on field
      }

      // YAC rate: how much of receiving yards came after the catch
      // High YAC = open-field weapon; low YAC = purely scheme-fed (system risk)
      let yacModifier = 0;
      if (stats.rec_yac > 0 && stats.rec_yd > 0) {
        yacRate = Math.min(1, stats.rec_yac / stats.rec_yd);
        if (yacRate >= 0.60) yacModifier = 8;       // open-field weapon, creates value independently
        else if (yacRate >= 0.45) yacModifier = 4;  // above-average YAC producer
        else if (yacRate < 0.20) yacModifier = -5;  // purely air-yards driven, scheme-dependent
      }

      // Catch rate + yards per target: target quality and reliability
      let catchModifier = 0;
      let yptModifier = 0;
      if (stats.tgt > 0) {
        catchRate = stats.rec / stats.tgt;
        yardsPerTarget = stats.rec_yd / stats.tgt;
        // Catch rate: elite separator catches 72%+; contested-catch-only guys catch <52%
        if (catchRate >= 0.72) catchModifier = 6;
        else if (catchRate >= 0.62) catchModifier = 2;
        else if (catchRate < 0.52) catchModifier = -6;
        // Yards per target: reveals quality of targets, not just volume
        if (yardsPerTarget >= 12) yptModifier = 8;    // deep + efficient
        else if (yardsPerTarget >= 9) yptModifier = 3;
        else if (yardsPerTarget < 6) yptModifier = -5; // dump-off / checkdown role
      }

      // Weights: volume (38%) + snap (20%) + air yards (17%) + RZ (15%) + scheme (10%) + quality bonuses
      score = tgtScore * 0.38 + snapScore * 0.20 + ayScore * 0.17 + rzScore * 0.15 + passRateBonus * 0.10 + alphaModifier + yacModifier + catchModifier + yptModifier + ypaBonus;
    }
  } else if (player.position === "RB") {
    if (agg.totalCarries > 0) {
      rushShare = (stats.rush_att || 0) / agg.totalCarries;
      recPerGame = (stats.rec || 0) / Math.max(stats.gp, 1);

      const rushScore = Math.min(100, (rushShare / 0.35) * 65);  // 35% = workhorse threshold
      // Receiving: receptions/game scaled to dynasty value (PPR/half-PPR premium)
      const recScore = Math.min(40, recPerGame * 9);
      const rzScore = agg.totalRzCarries > 0
        ? Math.min(25, ((stats.rz_rush_att || 0) / agg.totalRzCarries / 0.25) * 25)
        : 0;

      // Three-down workhorse detection: highest floor archetype in dynasty
      // Must have dominant snap share + carry share + genuine receiving role
      if (snapShare !== undefined) {
        if (snapShare >= 0.68 && rushShare >= 0.45 && recPerGame >= 2.5) {
          alphaModifier = 20;  // elite three-down workhorse (think Christian McCaffrey)
        } else if (snapShare >= 0.58 && rushShare >= 0.35 && recPerGame >= 1.5) {
          alphaModifier = 12;  // lead back with passing role
        } else if (rushShare >= 0.50 && snapShare < 0.55) {
          alphaModifier = 4;   // good rusher, limited passing role
        } else if (rushShare < 0.22 || (snapShare !== undefined && snapShare < 0.38)) {
          alphaModifier = -12; // committee / backup — severe ceiling cap
        }
      }

      // Weights: rush volume (42%) + snap security (22%) + receiving (23%) + RZ (13%) + role
      score = rushScore * 0.42 + snapScore * 0.22 + recScore * 0.23 + rzScore * 0.13 + alphaModifier;
    }
  } else if (player.position === "QB") {
    // Pass volume (scheme fit for QB — high-volume offenses inflate QB value)
    const passVol = Math.min(55, (agg.passAttPerGame / 38) * 55);  // 38 att/game = full score
    // Starts: snap share indicates starter vs backup (critical for QB dynasty value)
    const starterBonus = Math.min(30, (snapShare ?? 0) / 0.85 * 30);
    // Dual-threat rush upside
    const rushBonus = Math.min(20, ((stats.rush_att || 0) / Math.max(stats.gp, 1)) / 6 * 20);
    // QB efficiency: completion % and TD rate are the most predictive accuracy / red-zone signals
    let qbEffMod = 0;
    if (stats.pass_att > 0) {
      completionPct = stats.pass_cmp / stats.pass_att;
      tdRate = stats.pass_td / stats.pass_att;
      if (completionPct >= 0.68) qbEffMod += 8;      // highly accurate, dynasty stable
      else if (completionPct >= 0.63) qbEffMod += 3;
      else if (completionPct < 0.58) qbEffMod -= 8;  // erratic accuracy, dynasty value risk
      if (tdRate >= 0.06) qbEffMod += 6;              // elite red zone efficiency
      else if (tdRate >= 0.045) qbEffMod += 2;
      else if (tdRate < 0.03) qbEffMod -= 6;          // struggles to convert drives to TDs
    }
    score = passVol + starterBonus + rushBonus + qbEffMod;
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    targetShare, rushShare, airYardShare, snapShare, rzTargetShare, aDOT,
    alphaModifier, recPerGame,
    yacRate, yardsPerTarget, catchRate, completionPct, tdRate,
    teamPassRate: agg.passRate, teamYPA: agg.yardsPerPassAttempt,
  };
}

// ============================================================================
// Composite Edge Score
// ============================================================================

const WEIGHTS = { trajectory: 0.35, production: 0.35, teamFit: 0.30 };

export function computeEdgeScore(
  player: Player,
  settings: LeagueSettings,
  stats?: PlayerSeasonStats,
  teamAggs?: Record<string, TeamAggregates>
): PlayerProjection {
  const current = player.dynastyValue || 0;
  const v1 = projectPlayerValue(player, 1);
  const v3 = projectPlayerValue(player, 3);
  const delta1 = current > 0 ? (v1 - current) / current : 0;
  const trajectoryLabel = getTrajectoryLabel(player);

  // Trajectory score: 50 = flat, 0 = fast decline, 100 = fast rise
  const trajectoryScore = Math.min(100, Math.max(0, 50 + delta1 * 200));

  let productionScore = 50;
  let teamFitScore = 50;
  let fppg: number | undefined;
  let targetShare: number | undefined;
  let rushShare: number | undefined;

  let snapShare: number | undefined;
  let rzTargetShare: number | undefined;
  let aDOT: number | undefined;

  let alphaModifier: number | undefined;
  let recPerGame: number | undefined;
  let yacRate: number | undefined;
  let yardsPerTarget: number | undefined;
  let catchRate: number | undefined;
  let completionPct: number | undefined;
  let tdRate: number | undefined;
  let teamPassRate: number | undefined;
  let teamYPA: number | undefined;

  if (stats && stats.gp > 0) {
    productionScore = computeProductionScore(player, stats, settings);
    fppg = calcFPPG(stats, player.position, settings);

    if (teamAggs) {
      const fit = computeTeamFitScore(player, stats, teamAggs);
      teamFitScore = fit.score;
      targetShare = fit.targetShare;
      rushShare = fit.rushShare;
      snapShare = fit.snapShare;
      rzTargetShare = fit.rzTargetShare;
      aDOT = fit.aDOT;
      alphaModifier = fit.alphaModifier;
      recPerGame = fit.recPerGame;
      yacRate = fit.yacRate;
      yardsPerTarget = fit.yardsPerTarget;
      catchRate = fit.catchRate;
      completionPct = fit.completionPct;
      tdRate = fit.tdRate;
      teamPassRate = fit.teamPassRate;
      teamYPA = fit.teamYPA;
    }
  }

  // SF QB trajectory premium: young QBs in SF are dynasty cornerstones with the longest
  // productive shelf of any position. FantasyCalc lags 3-6 months on emerging starters.
  let trajectoryScoreAdj = trajectoryScore;
  if (player.position === "QB" && settings.superflex && current >= 20) {
    const sfMultiplier =
      player.age <= 23 ? 1.35 :  // elite young SF cornerstone in the making
      player.age <= 26 ? 1.25 :  // developing starter with huge ceiling
      player.age <= 29 ? 1.12 :  // established prime SF starter
      1.0;                        // veteran — market has fully priced it
    trajectoryScoreAdj = Math.min(100, trajectoryScore * sfMultiplier);
  }

  const edgeScore = Math.round(
    trajectoryScoreAdj * WEIGHTS.trajectory +
    productionScore * WEIGHTS.production +
    teamFitScore * WEIGHTS.teamFit
  );

  // Market score: dynastyValue is already on 0-100 scale (normalized at FantasyCalc import).
  // Do NOT divide by 100 again — that was correct only when dynastyValue was 0-10000.
  const marketScore = Math.min(100, current);
  const edgeDelta = Math.round(edgeScore - marketScore);

  // Human-readable signals
  const signals: string[] = [];

  if (trajectoryLabel === "RISING") {
    signals.push(`↑ Value +${Math.round(delta1 * 100)}% projected over 12 months`);
  } else if (trajectoryLabel === "DECLINING") {
    signals.push(`↓ Value -${Math.round(Math.abs(delta1) * 100)}% projected over 12 months`);
  } else if (trajectoryLabel === "PEAK") {
    signals.push(`⚡ At or near peak — sell window may be opening`);
  }

  // SF QB cornerstone signal (before snap share signals)
  if (player.position === "QB" && settings.superflex && current >= 20 && player.age <= 26) {
    signals.push(`🏰 SF Cornerstone — young franchise QB in superflex (highest dynasty shelf)`);
  }

  // Alpha role signals
  if (alphaModifier !== undefined) {
    if (alphaModifier >= 20) signals.push(`🔰 Alpha monopoly — dominant role, market underprices this scarcity`);
    else if (alphaModifier >= 12) signals.push(`⭐ True alpha — confirmed WR1/lead-back role`);
    else if (alphaModifier <= -10) signals.push(`⚠ Limited role — committee share / depth piece`);
  }

  // Three-down RB
  if (player.position === "RB" && alphaModifier !== undefined && recPerGame !== undefined) {
    if (alphaModifier >= 18) signals.push(`💪 Three-down workhorse — highest floor in dynasty (snap + carry + rec role)`);
    else if (alphaModifier >= 10) signals.push(`✅ Lead back with receiving role — strong dynasty floor`);
    else if (alphaModifier <= -10) signals.push(`🚨 Committee role — RB ceiling severely capped`);
  }

  if (snapShare !== undefined) {
    const pct = Math.round(snapShare * 100);
    if (pct >= 85) signals.push(`🔒 ${pct}% snap share — locked-in starter`);
    else if (pct >= 65) signals.push(`✓ ${pct}% snap share — reliable role`);
    else if (pct >= 45) signals.push(`⚠ ${pct}% snap share — rotational role, limited floor`);
    else signals.push(`🚨 ${pct}% snap share — bench/committee risk`);
  }

  if (targetShare !== undefined) {
    const pct = Math.round(targetShare * 100);
    if (pct >= 22) signals.push(`🎯 Elite ${pct}% target share`);
    else if (pct >= 16) signals.push(`✓ Solid ${pct}% target share`);
    else signals.push(`⚠ Low ${pct}% target share — limited role`);
  }

  if (rzTargetShare !== undefined && (player.position === "WR" || player.position === "TE")) {
    const pct = Math.round(rzTargetShare * 100);
    if (pct >= 20) signals.push(`🏆 ${pct}% RZ target share — major TD upside`);
    else if (pct >= 12) signals.push(`✓ ${pct}% RZ target share — solid TD role`);
    else signals.push(`→ ${pct}% RZ target share — limited goal-line usage`);
  }

  if (aDOT !== undefined && (player.position === "WR" || player.position === "TE")) {
    const d = aDOT.toFixed(1);
    if (aDOT >= 13) signals.push(`📡 ${d} aDOT — downfield threat, high ceiling/variance`);
    else if (aDOT >= 9) signals.push(`→ ${d} aDOT — intermediate route runner`);
    else signals.push(`📍 ${d} aDOT — short/slot route tree, floor-heavy profile`);
  }

  if (yacRate !== undefined && (player.position === "WR" || player.position === "TE")) {
    const pct = Math.round(yacRate * 100);
    if (yacRate >= 0.60) signals.push(`🏃 ${pct}% YAC rate — open-field weapon, creates value independently`);
    else if (yacRate >= 0.45) signals.push(`→ ${pct}% YAC rate — above-average run-after-catch`);
    else if (yacRate < 0.20) signals.push(`⚠ ${pct}% YAC rate — scheme-fed, value tied to system fit`);
  }

  if (catchRate !== undefined && (player.position === "WR" || player.position === "TE")) {
    const pct = Math.round(catchRate * 100);
    if (catchRate >= 0.72) signals.push(`🎯 ${pct}% catch rate — elite separator / sure hands`);
    else if (catchRate < 0.52) signals.push(`⚠ ${pct}% catch rate — contested-catch role, floor risk`);
  }

  if (yardsPerTarget !== undefined && (player.position === "WR" || player.position === "TE")) {
    const ypt = yardsPerTarget.toFixed(1);
    if (yardsPerTarget >= 12) signals.push(`⚡ ${ypt} yds/target — elite target quality (deep + efficient)`);
    else if (yardsPerTarget < 6) signals.push(`📍 ${ypt} yds/target — dump-off / checkdown role`);
  }

  // Scheme signals: pass/run balance and offensive efficiency
  if (teamPassRate !== undefined) {
    const ratePct = Math.round(teamPassRate * 100);
    if (player.position === "WR" || player.position === "TE") {
      if (teamPassRate > 0.62) signals.push(`🚀 ${ratePct}% pass rate — pass-heavy scheme, elevated WR/TE opportunity`);
      else if (teamPassRate < 0.42) signals.push(`⚠ ${ratePct}% pass rate — run-heavy scheme caps WR/TE ceiling`);
    } else if (player.position === "RB") {
      if (teamPassRate < 0.44) signals.push(`💪 ${ratePct}% pass rate — run-heavy scheme maximizes RB volume`);
      else if (teamPassRate > 0.62) signals.push(`⚠ ${ratePct}% pass rate — pass-heavy scheme reduces RB carry volume`);
    } else if (player.position === "QB") {
      if (teamPassRate > 0.60) signals.push(`📊 ${ratePct}% pass rate — high-volume scheme, elevated QB floor`);
    }
  }
  if (teamYPA !== undefined && (player.position === "WR" || player.position === "TE")) {
    const ypa = teamYPA.toFixed(1);
    if (teamYPA >= 8.5) signals.push(`⚡ ${ypa} YPA — explosive offense, premium value for downfield threats`);
    else if (teamYPA < 6.5) signals.push(`📉 ${ypa} YPA — inefficient offense depresses target value`);
  }

  if (rushShare !== undefined) {
    const pct = Math.round(rushShare * 100);
    if (pct >= 40) signals.push(`💪 Workhorse ${pct}% rush share`);
    else if (pct >= 25) signals.push(`✓ Lead back ${pct}% rush share`);
    else signals.push(`⚠ Committee role — only ${pct}% rush share`);
  }

  if (fppg !== undefined) {
    const avg = AVG_FPPG[player.position] ?? 10;
    const vsAvg = Math.round(((fppg - avg) / avg) * 100);
    if (vsAvg >= 25) signals.push(`📈 ${fppg.toFixed(1)} FPPG — ${vsAvg}% above position avg`);
    else if (vsAvg <= -25) signals.push(`📉 ${fppg.toFixed(1)} FPPG — ${Math.abs(vsAvg)}% below position avg`);
    else signals.push(`→ ${fppg.toFixed(1)} FPPG (near avg)`);
  }

  if (completionPct !== undefined && player.position === "QB") {
    const pct = Math.round(completionPct * 100);
    if (completionPct >= 0.68) signals.push(`🎯 ${pct}% completion — highly accurate, dynasty stable`);
    else if (completionPct >= 0.63) signals.push(`→ ${pct}% completion — solid accuracy`);
    else if (completionPct < 0.58) signals.push(`⚠ ${pct}% completion — accuracy concern, dynasty value at risk`);
  }

  if (tdRate !== undefined && player.position === "QB") {
    const pct = (tdRate * 100).toFixed(1);
    if (tdRate >= 0.06) signals.push(`🏆 ${pct}% TD rate — elite red zone efficiency`);
    else if (tdRate < 0.03) signals.push(`→ ${pct}% TD rate — below-average scoring efficiency`);
  }

  if (v3 > current * 1.3) {
    signals.push(`🔭 3-yr projection: +${Math.round(((v3 - current) / current) * 100)}% value growth`);
  } else if (v3 < current * 0.6) {
    signals.push(`⏳ 3-yr projection: -${Math.round(((current - v3) / current) * 100)}% value decay`);
  }

  // Recommendation logic
  let recommendation: PlayerProjection["recommendation"];
  if (edgeDelta >= 18) recommendation = "STRONG_BUY";
  else if (edgeDelta >= 8) recommendation = "BUY";
  else if (edgeDelta <= -18 || (trajectoryLabel === "DECLINING" && edgeDelta < -8)) recommendation = "STRONG_SELL";
  else if (edgeDelta <= -8 || trajectoryLabel === "DECLINING") recommendation = "SELL";
  else recommendation = "HOLD";

  return {
    playerId: player.id,
    currentValue: current,
    projectedValue1yr: Math.round(v1),
    projectedValue3yr: Math.round(v3),
    valueDelta1yr: delta1,
    trajectoryLabel,
    productionScore,
    teamFitScore,
    edgeScore,
    edgeDelta,
    fppg,
    targetShare,
    rushShare,
    signals,
    recommendation,
  };
}

/**
 * Convenience: compute projections for every rostered player across all teams.
 */
export function computeAllProjections(
  players: Player[],
  settings: LeagueSettings,
  playerStats: Record<string, PlayerSeasonStats>
): Record<string, PlayerProjection> {
  const playerTeamMap = Object.fromEntries(players.map((p) => [p.id, p.team]));
  const teamAggs = Object.keys(playerStats).length > 0
    ? computeTeamAggregates(playerStats, playerTeamMap)
    : undefined;

  const result: Record<string, PlayerProjection> = {};
  for (const player of players) {
    if (!["QB", "RB", "WR", "TE"].includes(player.position)) continue;
    result[player.id] = computeEdgeScore(
      player,
      settings,
      playerStats[player.id],
      teamAggs
    );
  }
  return result;
}
