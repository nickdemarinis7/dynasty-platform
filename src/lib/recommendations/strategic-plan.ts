import type { LeagueSettings, Player, TeamRoster } from "../../types/index.ts";
import { calculatePositionalNeed } from "../player-values.ts";
import { buildLeagueContext, getAssetTimeProfile } from "../trade-engine.ts";
import type { PlanStep, StrategicPlan, TradeIdea } from "./types.ts";

export interface StrategicPlanInput {
  recommendations: TradeIdea[];
  myRoster: TeamRoster | undefined;
  leagueSettings: LeagueSettings | null;
  personalValues: Record<string, number>;
  rosters: TeamRoster[];
  myTeamId: string | null;
  projectionAdjustedValues: Record<string, number>;
  getPlayerValue: (player: Player) => number;
}

function normalizeValue(value: number): number {
  return value > 150 ? Math.min(100, Math.round(value / 100)) : Math.min(100, value);
}

export function applyRecommendationToRoster(
  players: Player[],
  recommendation: TradeIdea,
  action: "buy" | "sell",
): Player[] {
  if (action === "sell") {
    const outgoingIds = recommendation.offeredPlayers.length > 0
      ? new Set(recommendation.offeredPlayers.map((player) => player.id))
      : new Set([recommendation.targetPlayer.id]);
    const remaining = players.filter((player) => !outgoingIds.has(player.id));
    return recommendation.receivingPicks
      ? remaining
      : [...remaining, recommendation.targetPlayer];
  }

  const outgoingIds = new Set(recommendation.offeredPlayers.map((player) => player.id));
  return [
    ...players.filter((player) => !outgoingIds.has(player.id)),
    recommendation.targetPlayer,
  ];
}

export function strategicStepHeadline(
  recommendation: TradeIdea,
  action: "buy" | "sell",
): string {
  if (action === "sell") {
    const soldPlayer = recommendation.offeredPlayers[0] ?? recommendation.targetPlayer;
    if (recommendation.receivingPicks?.length) {
      const picks = recommendation.receivingPicks
        .map((pick) => `${pick.year} R${pick.round}`)
        .join(" + ");
      return `Sell ${soldPlayer.name} → ${picks}`;
    }
    return `Sell ${soldPlayer.name} → Get ${recommendation.targetPlayer.name}`;
  }

  const offer = [
    ...recommendation.offeredPlayers.map((player) => player.name),
    ...(recommendation.offeredPicks?.map((pick) => `${pick.year} R${pick.round}`) ?? []),
  ].join(" + ");
  return `Send ${offer} → Get ${recommendation.targetPlayer.name}`;
}

export function buildStrategicPlan(input: StrategicPlanInput): StrategicPlan | null {
  const {
    recommendations, myRoster, leagueSettings, personalValues, rosters,
    myTeamId, projectionAdjustedValues, getPlayerValue,
  } = input;
    if (!myRoster || !leagueSettings || rosters.length === 0) return null;
    // Use same projection-adjusted values as the recommendations engine for consistency
    const planPValues: Record<string, number> = {
      ...projectionAdjustedValues,
      ...Object.fromEntries(Object.entries(personalValues).map(([id, v]) => [id, normalizeValue(v)])),
    };
    const leagueCtx = buildLeagueContext(rosters, leagueSettings, planPValues);
    const myCtx = myTeamId ? leagueCtx.get(myTeamId) : undefined;
    if (!myCtx) return null;

    const initialNeeds = calculatePositionalNeed(myRoster.players, leagueSettings.rosterSlots, leagueSettings.superflex, planPValues);
    const strengths = Object.entries(initialNeeds).filter(([, n]) => n < 15).map(([pos]) => pos);
    const weaknesses = Object.entries(initialNeeds).filter(([, n]) => n > 28).sort(([, a], [, b]) => b - a).map(([pos]) => pos);
    const teamSummary = {
      window: myCtx.windowLabel,
      windowColor: myCtx.windowColor,
      rank: myCtx.leagueRank,
      avgAge: myCtx.avgAge,
      strengths,
      weaknesses,
      positionRanks: myCtx.relativePositionRanks,
      dynastyPowerScore: myCtx.dynastyPowerScore,
      pickSurplusLabel: myCtx.pickSurplusLabel,
      pickCapital: myCtx.pickCapital,
      totalTeams: myCtx.totalTeams,
    };

    // Window-appropriate strategy directive — aligned with WINDOW_LABELS thresholds
    const windowStrategy: Record<string, string> = {
      "Rebuilding":  "Accumulate picks and youth. Sell aging veterans for future capital. Patience is the move.",
      "Young Core":  "Target players 25 and under. Protect your best young assets — don't mortgage the future for an aging rental.",
      "Balanced":    "Balanced window: selectively upgrade. Prioritize players 24-28 who match your timeline.",
      "Competing":   "Upgrade proven starters in the 25-29 range. Mix now and future — avoid win-now overpays.",
      "Win Now":     "Maximize current production. Trade future capital for proven contributors — the window is open.",
    };
    const strategyText = leagueSettings.mode === "redraft"
      ? "Maximize projected points for the current season. Upgrade weak starters, consolidate replaceable depth, and avoid paying for long-term upside."
      : windowStrategy[myCtx.windowLabel] ?? "Evaluate all trades carefully.";

    const steps: PlanStep[] = [];
    let simPlayers = [...myRoster.players];
    const usedKeys = new Set<string>();

    for (let phase = 1; phase <= 3; phase++) {
      const curNeeds = calculatePositionalNeed(simPlayers, leagueSettings.rosterSlots, leagueSettings.superflex, planPValues);
      // Bottom-third relative rank = structurally weak regardless of absolute need score
      const bottomThirdCutoff = Math.floor(myCtx.totalTeams * 2 / 3);
      const isUrgentNeed = (pos: string, n: number): boolean => {
        if (n > 28) return true;
        const relRank = myCtx.relativePositionRanks[pos];
        return relRank !== undefined && relRank > bottomThirdCutoff;
      };
      const topNeedEntry = Object.entries(curNeeds)
        .sort(([, a], [, b]) => b - a)
        .find(([pos, n]) => isUrgentNeed(pos, n));

      const availableSells = recommendations.filter(r =>
        r.type === "sell" &&
        !usedKeys.has(`${r.targetPlayer.id}-${r.targetTeamId}`) &&
        (
          (r.offeredPlayers.length > 0 && simPlayers.some(p => p.id === r.offeredPlayers[0].id)) ||
          (r.receivingPicks && simPlayers.some(p => p.id === r.targetPlayer.id))
        )
      );

      const urgentSell = availableSells.find(r => {
        const aging = r.offeredPlayers[0] ?? (r.receivingPicks ? r.targetPlayer : null);
        if (!aging) return false;
        // Dead zone players and rapidly declining curves are both urgent
        return myCtx.deadZonePlayerIds.includes(aging.id) ||
          getAssetTimeProfile(aging.position, aging.age).futureFactor < 0.5;
      });

      // Count ascending (futureFactor > 1.1) players per position — used to detect
      // positions already being built through draft capital so we don't double-dip.
      const ascendingCountByPos: Record<string, number> = {};
      for (const p of simPlayers) {
        if (!ascendingCountByPos[p.position]) ascendingCountByPos[p.position] = 0;
        // Only count players with real value — roster fillers with near-zero dynasty value
        // shouldn't block surfacing genuine upgrade opportunities.
        if (getAssetTimeProfile(p.position, p.age).futureFactor > 1.1 && getPlayerValue(p) >= 20) ascendingCountByPos[p.position]++;
      }
      // topNeedEntry is used only for HOLD context messaging; actual buy search iterates all needs.
      const posAlreadyBeingBuilt = leagueSettings.mode !== "redraft" && topNeedEntry
        ? (ascendingCountByPos[topNeedEntry[0]] ?? 0) >= 2
        : false;

      // For Young Core / Rebuilding teams, only consider targets with real future upside
      const isWindowFit = (player: Player): boolean => {
        if (myCtx.winNowWeight > 0.42) return true; // Competing / Win Now: any age is fine
        const tp = getAssetTimeProfile(player.position, player.age);
        if (tp.futureFactor < 0.75) return false;
        // Hard age cap per position: QB curves have long shelves so futureFactor alone
        // won't filter a 30-year-old QB — add explicit caps for non-Win-Now teams.
        const posAgeCap: Record<string, number> = { QB: 30, RB: 25, WR: 28, TE: 30 };
        const cap = posAgeCap[player.position];
        if (cap !== undefined && player.age >= cap) return false;
        return true;
      };

      // Position viability: don't accept trades that strip a position below minimum depth
      const posMinViable: Record<string, number> = {
        QB: leagueSettings!.superflex ? 2 : 1,
        RB: 2, WR: 2, TE: 1,
      };
      const isPositionSafe = (r: TradeIdea) =>
        r.offeredPlayers.every(op => {
          const remaining = simPlayers.filter(p => p.position === op.position && p.id !== op.id).length;
          if (remaining < (posMinViable[op.position] ?? 1) + 1) return false;
          // Never offer the team's single most-valuable player at any position—they are untouchable
          const topAtPos = [...simPlayers]
            .filter(p => p.position === op.position)
            .sort((a, b) => getPlayerValue(b) - getPlayerValue(a))[0];
          if (topAtPos?.id === op.id) return false;
          return true;
        });

      // Iterate all need positions in descending order — skip those already being built organically.
      // Also include any position ranked bottom-third in the league, even if absolute need < 28%.
      const allNeedEntries = Object.entries(curNeeds)
        .filter(([pos, n]) => isUrgentNeed(pos, n))
        .sort(([posA, nA], [posB, nB]) => {
          // Composite urgency: absolute need% + relative rank severity
          // Rank in bottom third adds up to 50 urgency points (worst rank = +50)
          const rankA = myCtx.relativePositionRanks[posA] ?? 1;
          const rankB = myCtx.relativePositionRanks[posB] ?? 1;
          const rankUrgencyA = myCtx.totalTeams > 1 ? ((rankA - 1) / (myCtx.totalTeams - 1)) * 50 : 0;
          const rankUrgencyB = myCtx.totalTeams > 1 ? ((rankB - 1) / (myCtx.totalTeams - 1)) * 50 : 0;
          return (nB + rankUrgencyB) - (nA + rankUrgencyA);
        });
      let safeBuys: TradeIdea[] = [];
      for (const needEntry of allNeedEntries) {
        if ((ascendingCountByPos[needEntry[0]] ?? 0) >= 2) continue; // position already being built
        const buysForPos = recommendations.filter(r =>
          (r.type === "buy" || r.type === "upgrade" || r.type === "2for1" || r.type === "pick") &&
          r.targetPlayer.position === needEntry[0] &&
          !usedKeys.has(`${r.targetPlayer.id}-${r.targetTeamId}`) &&
          r.offeredPlayers.every(op => simPlayers.some(p => p.id === op.id)) &&
          isWindowFit(r.targetPlayer) &&
          r.verdictTone !== "bad"
        ).sort((a, b) => {
          if (Math.abs(a.valueDiff - b.valueDiff) > 5) return a.valueDiff - b.valueDiff;
          return b.acceptanceLikelihood - a.acceptanceLikelihood;
        });
        const safeForPos = buysForPos.filter(isPositionSafe);
        if (safeForPos.length > 0) {
          safeBuys = safeForPos;
          break;
        }
      }
      const safeSells = availableSells
        .filter(isPositionSafe)
        .sort((a, b) => {
          // Prefer player-for-player sells (you receive a player, not just a pick)
          // A young player return is always more valuable than an equivalent pick
          const aIsPlayer = a.offeredPlayers.length > 0;
          const bIsPlayer = b.offeredPlayers.length > 0;
          if (aIsPlayer !== bIsPlayer) return aIsPlayer ? -1 : 1;
          return b.acceptanceLikelihood - a.acceptanceLikelihood;
        });
      const safeUrgentSell = urgentSell && isPositionSafe(urgentSell) ? urgentSell : null;

      let chosen: TradeIdea | null = null;
      let chosenType: "buy" | "sell" = "sell";
      if (safeUrgentSell) { chosen = safeUrgentSell; chosenType = "sell"; }
      else if (safeBuys.length > 0) { chosen = safeBuys[0]; chosenType = "buy"; }
      else if (safeSells.length > 0) { chosen = safeSells[0]; chosenType = "sell"; }

      if (!chosen) {
        const rank = myCtx.leagueRank;
        const totalTeams = myCtx.totalTeams;
        const belowMedian = rank > Math.ceil(totalTeams / 2);

        // Dead zone override: if no trade found but we have dead zone assets, push a sell directive
        const uncoveredDeadZone = myCtx.deadZonePlayerIds
          .map(id => simPlayers.find(p => p.id === id))
          .filter(Boolean) as Player[];
        if (uncoveredDeadZone.length > 0) {
          const dzp = uncoveredDeadZone[0];
          steps.push({
            phase,
            type: "sell",
            headline: `Shop ${dzp.name} Now — Dead Zone Asset`,
          context: `${dzp.name} (age ${dzp.age}, ${dzp.position}) is in the dead zone: still has tradeable value but losing it fast every month. Actively shop to the other ${Math.max(1, totalTeams - 1)} teams now before the market prices in the decline.`,
            needsBefore: curNeeds,
          });
          break;
        }

        let holdHeadline: string;
        let holdContext: string;
        if (posAlreadyBeingBuilt && topNeedEntry) {
          const pos = topNeedEntry[0];
          const developingPlayers = simPlayers
            .filter(p => p.position === pos && getAssetTimeProfile(p.position, p.age).futureFactor > 1.1 && getPlayerValue(p) >= 15)
            .sort((a, b) => getPlayerValue(b) - getPlayerValue(a))
            .slice(0, 3);
          holdHeadline = `Let Your Young ${pos}s Develop`;
          holdContext = `You already have ${developingPlayers.map(p => `${p.name} (age ${p.age})`).join(" and ")} coming up at ${pos}. Hold your capital and let them develop — adding another ${pos} would be redundant.`;
        } else if (belowMedian) {
          // Use worst relative position rank for a specific, actionable message
          const worstRelPos = Object.entries(myCtx.relativePositionRanks)
            .sort(([, a], [, b]) => b - a)
            .find(([, r]) => r > Math.ceil(totalTeams / 2));
          if (worstRelPos) {
            holdHeadline = `Build Up ${worstRelPos[0]} — You Rank #${worstRelPos[1]} of ${totalTeams}`;
            holdContext = `Your ${worstRelPos[0]} group ranks #${worstRelPos[1]} of ${totalTeams} teams (${leagueSettings.mode === "redraft" ? "Roster" : "Dynasty"} Score: ${myCtx.dynastyPowerScore}/100). No clean trades surfaced right now — continue targeting ${worstRelPos[0]} upgrades and monitor all rosters.`;
          } else {
            holdHeadline = `Improve Value at ${topNeedEntry?.[0] ?? "Key Positions"}`;
            holdContext = `Ranked #${rank} of ${totalTeams} (${leagueSettings.mode === "redraft" ? "Roster" : "Dynasty"} Score: ${myCtx.dynastyPowerScore}/100). No clean trades surfaced — continue targeting ${topNeedEntry?.[0] ?? "all positions"} upgrades.`;
          }
        } else {
          holdHeadline = leagueSettings.mode === "redraft" ? "Hold — Your Starting Lineup Is Balanced" : "Hold & Let Roster Develop";
          holdContext = leagueSettings.mode === "redraft"
            ? `Roster Score ${myCtx.dynastyPowerScore}/100. No fair trade currently projects as a meaningful lineup upgrade, so preserve your depth and monitor weekly roles.`
            : `Dynasty Score ${myCtx.dynastyPowerScore}/100. Your roster needs are balanced — let young players grow into contributors. No urgent moves needed right now.`;
        }
        steps.push({ phase, type: "hold", headline: holdHeadline, context: holdContext, needsBefore: curNeeds });
        break;
      }

      usedKeys.add(`${chosen.targetPlayer.id}-${chosen.targetTeamId}`);

      simPlayers = applyRecommendationToRoster(simPlayers, chosen, chosenType);

      const needsAfter = calculatePositionalNeed(simPlayers, leagueSettings.rosterSlots, leagueSettings.superflex, planPValues);

      const headline = strategicStepHeadline(chosen, chosenType);

      const fixedPos = topNeedEntry?.[0];
      const remainingTop = Object.entries(needsAfter).sort(([, a], [, b]) => b - a)[0];
      let context = chosen.reason;
      if (fixedPos) {
        const before = Math.round(curNeeds[fixedPos] || 0);
        const after = Math.round(needsAfter[fixedPos] || 0);
        if (after < before) context += ` Drops your ${fixedPos} need from ${before}% → ${after}%.`;
      }
      if (remainingTop && remainingTop[1] > 30 && remainingTop[0] !== fixedPos) {
        context += ` Next priority: ${remainingTop[0]}.`;
      }

      steps.push({ phase, type: chosenType, trade: chosen, headline, context, needsBefore: curNeeds, needsAfter });
    }

    return { teamSummary, windowStrategy: strategyText, steps };

}
