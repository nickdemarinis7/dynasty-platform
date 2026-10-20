import type { HistoricalTradeAnalysis, LeagueSettings, Player, PlayerProjection, RosterSlot, TeamRoster } from "../../types/index.ts";
import { DEFAULT_DYNASTY_VALUES, calculatePositionalNeed } from "../player-values.ts";
import { findPickCombinations } from "../recommendation-realism.ts";
import { evaluateTrade, getAssetTimeProfile, type SmartTradeResult, type TeamContext } from "../trade-engine.ts";
import type { TradeIdea } from "./types.ts";

export interface CandidateContext {
  rosters: TeamRoster[];
  myTeamId: string;
  myRoster: TeamRoster;
  myTeam: TeamContext;
  league: Map<string, TeamContext>;
  needs: Record<string, number>;
  projections: Record<string, PlayerProjection>;
  lineupPointEstimates: Record<string, number>;
  personalValues: Record<string, number>;
  effectiveValues: Record<string, number>;
  leagueSettings: LeagueSettings;
  getPlayerValue: (player: Player) => number;
}

export function generateRecommendationCandidates(
  context: CandidateContext,
  tradeAnalysis: HistoricalTradeAnalysis | null,
  generateTradeRoadmap: TradeRoadmapBuilder,
): TradeIdea[] {
  const isRedraft = context.leagueSettings.mode === "redraft";
  return [
    ...generateAcquisitionCandidates(context, tradeAnalysis, generateTradeRoadmap),
    ...(isRedraft ? [] : generateSellCandidates(context)),
    ...generateBuyLowCandidates(context),
    ...(isRedraft ? [] : generatePurePickCandidates(context)),
  ];
}

function normalizedMarketValue(player: Player): number {
  const value = player.dynastyValue || DEFAULT_DYNASTY_VALUES[player.name] || 0;
  return value > 150 ? Math.min(100, Math.round(value / 100)) : Math.min(100, value);
}

function normalizeValue(value: number): number {
  return value > 150 ? Math.min(100, Math.round(value / 100)) : Math.min(100, value);
}

export type TradeRoadmapBuilder = (
  currentPlayers: Player[],
  targetPlayer: Player,
  offeredPlayer: Player,
  rosterSlots: RosterSlot[],
  superflex: boolean,
  values: Record<string, number>,
) => string[];

export function containsAnchor(players: Player[], team: TeamContext): boolean {
  return players.some((player) => team.anchorPlayerIds.includes(player.id));
}

export function generateSellCandidates(context: CandidateContext): TradeIdea[] {
  const ideas: TradeIdea[] = [];
  const { myRoster, myTeam, rosters, myTeamId, league, needs, projections,
    lineupPointEstimates, effectiveValues, leagueSettings, getPlayerValue } = context;

  for (const myPlayer of myRoster.players) {
    const myValue = getPlayerValue(myPlayer);
    if (myValue < 25 || containsAnchor([myPlayer], myTeam)) continue;

    const profile = getAssetTimeProfile(myPlayer.position, myPlayer.age);
    const isDeadZonePlayer = myTeam.deadZonePlayerIds.includes(myPlayer.id);
    const projection = projections[myPlayer.id];
    const isMarketOvervaluing = !!(
      projection && projection.edgeDelta < -8 && projection.trajectoryLabel === "DECLINING"
    );
    const isSellHighCandidate = isDeadZonePlayer || isMarketOvervaluing ||
      (profile.nowFactor >= 1 && profile.futureFactor < 0.72) ||
      (myPlayer.age >= 29 && profile.futureFactor < 0.55);
    if (!isSellHighCandidate || (needs[myPlayer.position] ?? 0) > 40) continue;

    for (const otherRoster of rosters) {
      if (otherRoster.teamId === myTeamId) continue;
      const otherTeam = league.get(otherRoster.teamId);
      if (!otherTeam) continue;
      const partnerFits = otherTeam.positionNeeds[myPlayer.position] > 25 ||
        otherTeam.winNowWeight >= 0.4 || otherTeam.pickSurplusLabel === "surplus";
      if (!partnerFits) continue;

      const youngAssets = otherRoster.players
        .filter((player) => {
          const assetProfile = getAssetTimeProfile(player.position, player.age);
          const value = getPlayerValue(player);
          return assetProfile.futureFactor > 1.1 && value >= myValue * 0.35 && value <= myValue * 1.35;
        })
        .sort((a, b) => getPlayerValue(b) - getPlayerValue(a));

      for (const youngPlayer of youngAssets.slice(0, 2)) {
        const youngValue = getPlayerValue(youngPlayer);
        const valueDiff = youngValue - myValue;
        if (Math.abs(valueDiff) > myValue * 0.45) continue;
        if (normalizedMarketValue(youngPlayer) < normalizedMarketValue(myPlayer) * 0.7) continue;
        const evaluation = evaluateTrade({
          teamACtx: myTeam, teamBCtx: otherTeam,
          aGivesPlayers: [myPlayer], aGivesPicks: [],
          bGivesPlayers: [youngPlayer], bGivesPicks: [],
          personalValues: effectiveValues,
          lineupPointEstimates,
          teamARoster: myRoster.players, teamBRoster: otherRoster.players, leagueSettings,
        });
        if (evaluation.acceptanceLikelihood <= 15 || evaluation.marketFairness <= -20) continue;
        const signal = isDeadZonePlayer ? "⚠ Dead zone asset — sell NOW before value drops." :
          isMarketOvervaluing ? "Market hasn't priced in the decline yet — ideal sell window." :
          "Future curve declining — sell while still at peak.";
        ideas.push({
          type: "sell", targetPlayer: youngPlayer, targetTeamId: otherRoster.teamId,
          targetTeamName: otherRoster.teamName, offeredPlayers: [myPlayer], evalResult: evaluation,
          valueDiff, reason: `Sell-high on ${myPlayer.name} (age ${myPlayer.age}). ${signal} Get younger ${youngPlayer.name} (age ${youngPlayer.age}).`,
          priority: isDeadZonePlayer || profile.futureFactor < 0.5 ? "high" : "medium",
          acceptanceLikelihood: evaluation.acceptanceLikelihood, verdictTone: evaluation.verdictForA.tone,
        });
      }

      const pick = otherRoster.draftPicks
        .filter((candidate) => candidate.estimatedValue >= myValue * 0.35)
        .sort((a, b) => b.estimatedValue - a.estimatedValue)[0];
      if (!pick) continue;
      const valueDiff = pick.estimatedValue - myValue;
      if (Math.abs(valueDiff) > myValue * 0.55 || pick.estimatedValue < normalizedMarketValue(myPlayer) * 0.7) continue;
      const evaluation = evaluateTrade({
        teamACtx: myTeam, teamBCtx: otherTeam,
        aGivesPlayers: [myPlayer], aGivesPicks: [], bGivesPlayers: [], bGivesPicks: [pick],
        personalValues: effectiveValues,
        lineupPointEstimates,
        teamARoster: myRoster.players, teamBRoster: otherRoster.players, leagueSettings,
      });
      const threshold = otherTeam.pickSurplusLabel === "surplus" ? 10 : 15;
      if (evaluation.acceptanceLikelihood <= threshold || evaluation.marketFairness <= -25) continue;
      const signal = isDeadZonePlayer ? "⚠ Dead zone — sell for capital NOW." :
        isMarketOvervaluing ? "Market overvaluing — ideal sell window for picks." :
        "Future value curve is declining.";
      const capitalNote = otherTeam.pickSurplusLabel === "surplus"
        ? ` ${otherRoster.teamName} has pick capital to spend.` : "";
      ideas.push({
        type: "sell", targetPlayer: myPlayer, targetTeamId: otherRoster.teamId,
        targetTeamName: otherRoster.teamName, offeredPlayers: [myPlayer], evalResult: evaluation,
        receivingPicks: [{ year: pick.year, round: pick.round, estimatedValue: pick.estimatedValue }],
        valueDiff, reason: `Trade ${myPlayer.name} to ${otherRoster.teamName} for ${pick.year} R${pick.round}.${capitalNote} ${signal}`,
        priority: isDeadZonePlayer || profile.futureFactor < 0.5 ? "high" : "medium",
        acceptanceLikelihood: evaluation.acceptanceLikelihood, verdictTone: evaluation.verdictForA.tone,
      });
    }
  }
  return ideas;
}

export function generateBuyLowCandidates(context: CandidateContext): TradeIdea[] {
  const ideas: TradeIdea[] = [];
  for (const roster of context.rosters) {
    if (roster.teamId === context.myTeamId) continue;
    for (const player of roster.players) {
      const marketValue = normalizedMarketValue(player);
      const override = context.personalValues[player.id];
      const personalValue = override === undefined
        ? undefined
        : override > 150 ? Math.min(100, Math.round(override / 100)) : Math.min(100, override);
      if (!personalValue || marketValue <= 1 || personalValue <= marketValue * 1.2 || personalValue <= 20) continue;
      ideas.push({
        type: "buy-low", targetPlayer: player, targetTeamId: roster.teamId,
        targetTeamName: roster.teamName, offeredPlayers: [], valueDiff: personalValue - marketValue,
        reason: `You value ${player.name} ${Math.round(((personalValue - marketValue) / marketValue) * 100)}% above market. Buy while others are sleeping on him.`,
        priority: "medium", acceptanceLikelihood: 55, verdictTone: "fair",
      });
    }
  }
  return ideas;
}

export function generateAcquisitionCandidates(
  context: CandidateContext,
  tradeAnalysis: HistoricalTradeAnalysis | null,
  generateTradeRoadmap: TradeRoadmapBuilder,
): TradeIdea[] {
  const {
    rosters, myTeamId, myRoster, myTeam: myCtx, league: leagueCtx,
    needs: myNeeds, personalValues, effectiveValues: effectivePValues,
    lineupPointEstimates, leagueSettings, getPlayerValue,
  } = context;
  const ideas: TradeIdea[] = [];
  const getPosMultiplier = (pos: string): number => {
    if (leagueSettings.tePremium && pos === "TE") return 1.3;
    if (leagueSettings.superflex && pos === "QB") return 1.2;
    return 1;
  };
  const needPriority = Object.entries(myNeeds).sort(([, a], [, b]) => b - a).filter(([, need]) => need > 20);
  const myPlayersByPos: Record<string, Player[]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const player of myRoster.players) {
    if (myPlayersByPos[player.position]) myPlayersByPos[player.position].push(player);
  }
  for (const position of Object.keys(myPlayersByPos)) {
    myPlayersByPos[position].sort((a, b) => getPlayerValue(a) - getPlayerValue(b));
  }
  const posMinDepth: Record<string, number> = {
    QB: leagueSettings.superflex ? 2 : 1,
    RB: 2, WR: 2, TE: 1,
  };

    // ===== BUY / UPGRADE with window alignment =====
    for (const [neededPos, needLevel] of needPriority) {
      for (const otherRoster of rosters) {
        if (otherRoster.teamId === myTeamId) continue;
        const otherCtx = leagueCtx.get(otherRoster.teamId);
        if (!otherCtx) continue;

        // Window alignment: opposite windows = more likely to make complementary trades
        const windowDiff = Math.abs(myCtx.winNowWeight - otherCtx.winNowWeight);
        const windowAligned = leagueSettings.mode !== "redraft" && windowDiff > 0.25;
        // Thresholds lowered for 25% acceptance base (was 35/40)
        const adjustedAcceptThreshold = windowAligned ? 15 : 20;

        const theirPlayers = otherRoster.players.filter((p) => p.position === neededPos).sort((a, b) => getPlayerValue(b) - getPlayerValue(a));
        const theirNeeds = calculatePositionalNeed(otherRoster.players, leagueSettings.rosterSlots, leagueSettings.superflex, personalValues);
        const theirStyle = tradeAnalysis?.teamStyles[otherRoster.teamId];
        const theirPreferredPositions = theirStyle?.preferredPositionsToAcquire || [];

        const theirHighNeedPositions = Object.entries(theirNeeds).filter(([, n]) => n > 15).map(([pos]) => pos);
        const boostedPositions = new Set(theirHighNeedPositions);
        theirPreferredPositions.forEach((pos: string) => boostedPositions.add(pos));

        const targetTradeOptions: Map<string, Array<{
          offerPlayer: Player;
          offerValue: number;
          diff: number;
          acceptance: number;
          verdictTone: "good" | "fair" | "bad";
          reason: string;
          evalResult?: SmartTradeResult;
        }>> = new Map();

        for (const target of theirPlayers.slice(0, 5)) {
          const targetValue = getPlayerValue(target) * getPosMultiplier(target.position);
          if (targetValue < 15) continue;
          // QB pre-multiplier guard: raw value must be ≥30 to be dynasty-relevant in SF
          // (1.2× multiplier can lift a backup QB past threshold — this prevents it)
          if (target.position === "QB" && getPlayerValue(target) < 30) continue;

          // Don't acquire clearly declining players — high age + low future curve
          const targetProfile = getAssetTimeProfile(target.position, target.age);
          if (leagueSettings.mode !== "redraft" && target.age > 31 && targetProfile.futureFactor < 0.4) continue;

          const options: Array<{ 
            offerPlayer: Player; 
            offerValue: number; 
            diff: number; 
            acceptance: number; 
            verdictTone: "good" | "fair" | "bad"; 
            reason: string;
            evalResult?: SmartTradeResult;
          }> = [];

          for (const offerPos of boostedPositions) {
            // Skip same-position swaps — rarely makes sense and creates circular suggestions
            if (offerPos === neededPos) continue;
            const swapKey = `${offerPos}->${neededPos}`;
            const historicalPattern = tradeAnalysis?.patterns.find((p) => p.positionSwap === swapKey);
            const isHistoricallyCommon = historicalPattern && historicalPattern.count >= 2;
            const ourSurplus = myPlayersByPos[offerPos];
            if (!ourSurplus || ourSurplus.length <= 1) continue;

            const expendable = ourSurplus.filter((p) => {
              // Use raw value for offer comparison — the target already has pos multiplier applied.
              // Applying multiplier to BOTH sides cancels same-pos and distorts cross-pos trades.
              const offerValue = getPlayerValue(p);
              return offerValue >= targetValue * 0.5 && offerValue <= targetValue * 1.5;
            });

            for (const offerPlayer of expendable) {
              // Depth guard: don't offer this player if it would leave the position critically depleted
              const remainAfterOffer = (myPlayersByPos[offerPlayer.position]?.length ?? 0) - 1;
              if (remainAfterOffer < posMinDepth[offerPlayer.position]) continue;
              // Anchor protection: never offer untouchable franchise assets
              if (containsAnchor([offerPlayer], myCtx)) continue;

              const offerValue = getPlayerValue(offerPlayer);
              const diff = offerValue - targetValue;
              if (Math.abs(diff) < targetValue * 0.25) {
                // Raw-value sanity check: projection adjustments can lower a player's effective value
                // (e.g. aging RB with declining curve) and make a lopsided trade look filter-safe.
                // But the market — and our UI — shows raw dynastyValue. Cap raw disadvantage at 20%.
                const rawOffer = normalizeValue(offerPlayer.dynastyValue || DEFAULT_DYNASTY_VALUES[offerPlayer.name] || 0);
                const rawTarget = normalizeValue(target.dynastyValue || DEFAULT_DYNASTY_VALUES[target.name] || 0);
                if (rawOffer > rawTarget * 1.20) continue;
                const evalResult = evaluateTrade({
                  teamACtx: myCtx,
                  teamBCtx: otherCtx,
                  aGivesPlayers: [offerPlayer],
                  aGivesPicks: [],
                  bGivesPlayers: [target],
                  bGivesPicks: [],
                  personalValues: effectivePValues,
                  lineupPointEstimates,
                  teamARoster: myRoster.players,
                  teamBRoster: otherRoster.players,
                  leagueSettings,
                });

                // Only surface trades where market fairness isn't strongly against us (> -12%)
                if (evalResult.marketFairness > -12 && evalResult.acceptanceLikelihood > adjustedAcceptThreshold) {
                  const windowNote = windowAligned ? ` Windows align (${myCtx.windowLabel} ↔ ${otherCtx.windowLabel}).` : "";
                  options.push({
                    offerPlayer,
                    offerValue,
                    diff,
                    acceptance: evalResult.acceptanceLikelihood,
                    verdictTone: evalResult.verdictForA.tone,
                    reason: `You need ${neededPos}, they need ${offerPos}.${windowNote} ${evalResult.verdictForA.label}. (opponent fit ${Math.round(evalResult.acceptanceLikelihood)}/100${isHistoricallyCommon ? `, ${historicalPattern.count} similar trades historically` : ""})`,
                    evalResult,
                  });
                }
              }
            }
          }

          if (options.length > 0) targetTradeOptions.set(target.id, options);
        }

        for (const [targetId, options] of targetTradeOptions) {
          const target = theirPlayers.find((p) => p.id === targetId);
          if (!target) continue;
          options.sort((a, b) => b.acceptance - a.acceptance || Math.abs(a.diff) - Math.abs(b.diff));
          const bestOption = options[0];
          const roadmap = generateTradeRoadmap(myRoster.players, target, bestOption.offerPlayer, leagueSettings.rosterSlots, leagueSettings.superflex, personalValues);

          ideas.push({
            type: "buy",
            targetPlayer: target,
            targetTeamId: otherRoster.teamId,
            targetTeamName: otherRoster.teamName,
            offeredPlayers: [bestOption.offerPlayer],
            valueDiff: bestOption.diff,
            reason: bestOption.reason,
            priority: needLevel > 50 ? "high" : needLevel > 30 ? "medium" : "low",
            acceptanceLikelihood: bestOption.acceptance,
            verdictTone: bestOption.verdictTone,
            tradeOptions: options,
            roadmap,
            evalResult: bestOption.evalResult,
          });
        }

        // Player + pick sweetener trades
        for (const target of theirPlayers.slice(0, 5)) {
          const targetValue = getPlayerValue(target) * getPosMultiplier(target.position);
          if (targetValue < 20) continue;
          if (target.position === "QB" && getPlayerValue(target) < 30) continue;
          // Don't acquire clearly declining players — same guard as main buy loop
          const targetProfilePick = getAssetTimeProfile(target.position, target.age);
          if (leagueSettings.mode !== "redraft" && target.age > 31 && targetProfilePick.futureFactor < 0.4) continue;
          const myValuablePicks = myRoster.draftPicks.filter((p) => p.estimatedValue >= 15);
          if (myValuablePicks.length === 0) continue;

          for (const offerPos of theirHighNeedPositions) {
            const ourSurplus = myPlayersByPos[offerPos];
            if (!ourSurplus || ourSurplus.length <= 1) continue;
            for (const offerPlayer of ourSurplus.slice(-3)) {
              // Depth guard on sweetener trades too
              const remainAfterOffer = (myPlayersByPos[offerPlayer.position]?.length ?? 0) - 1;
              if (remainAfterOffer < posMinDepth[offerPlayer.position]) continue;
              if (containsAnchor([offerPlayer], myCtx)) continue;

              const offerValue = getPlayerValue(offerPlayer) * getPosMultiplier(offerPlayer.position);
              
              // Find best pick combination to sweeten the deal
              const neededPickValue = targetValue - offerValue;
              if (neededPickValue < 5) continue; // Player alone is close enough
              
              const pickCombos = findPickCombinations(
                myValuablePicks,
                neededPickValue,
                2,  // Max 2 picks as sweetener (player + 2 picks = 3 assets total)
                0.4  // 40% tolerance for sweeteners
              );
              
              if (pickCombos.length > 0) {
                const bestPickCombo = pickCombos[0];
                const combinedValue = offerValue + bestPickCombo.totalValue;
                
                // Pick(s) must be meaningful sweetener: contributes ≥10% of combined offer
                if (bestPickCombo.totalValue / combinedValue < 0.10) continue;
                // Offered player must contribute meaningfully — no garbage-player+pick combos
                if (offerValue < 15 || offerValue / combinedValue < 0.15) continue;
                
                const evalResult = evaluateTrade({ 
                  teamACtx: myCtx, 
                  teamBCtx: otherCtx, 
                  aGivesPlayers: [offerPlayer], 
                  aGivesPicks: bestPickCombo.picks, 
                  bGivesPlayers: [target], 
                  bGivesPicks: [], 
                  personalValues: effectivePValues,
                  lineupPointEstimates,
                  teamARoster: myRoster.players, 
                  teamBRoster: otherRoster.players, 
                  leagueSettings 
                });
                
                // Directional check: don't recommend trades that are significantly against us
                if (evalResult.marketFairness > -10 && evalResult.acceptanceLikelihood > 15) {
                  ideas.push({
                    type: "pick",
                    targetPlayer: target,
                    targetTeamId: otherRoster.teamId,
                    targetTeamName: otherRoster.teamName,
                    offeredPlayers: [offerPlayer],
                    offeredPicks: bestPickCombo.picks.map(p => ({ 
                      year: p.year, 
                      round: p.round, 
                      estimatedValue: p.estimatedValue 
                    })),
                    evalResult,
                    valueDiff: combinedValue - targetValue,
                    reason: `Add ${bestPickCombo.description} to sweeten the deal. (opponent fit ${Math.round(evalResult.acceptanceLikelihood)}/100)`,
                    priority: needLevel > 50 ? "high" : "medium",
                    acceptanceLikelihood: evalResult.acceptanceLikelihood,
                    verdictTone: evalResult.verdictForA.tone,
                  });
                }
              }
            }
          }
        }

        // 2-for-1 trades
        for (const target of theirPlayers.slice(0, 3)) {
          const targetValue = getPlayerValue(target) * getPosMultiplier(target.position);
          if (targetValue < 30) continue;
          if (target.position === "QB" && getPlayerValue(target) < 30) continue;
          // Don't acquire clearly declining players
          const targetProfile2for1 = getAssetTimeProfile(target.position, target.age);
          if (leagueSettings.mode !== "redraft" && target.age > 31 && targetProfile2for1.futureFactor < 0.4) continue;
          for (const offerPos of theirHighNeedPositions) {
            const ourSurplus = myPlayersByPos[offerPos];
            // Need 4+ at position: offer 2nd+3rd best, keep your starter (#1) and still have a backup
            if (!ourSurplus || ourSurplus.length < 4) continue;
            for (let i = 1; i < Math.min(ourSurplus.length - 1, 3); i++) {
              for (let j = i + 1; j < Math.min(ourSurplus.length, 4); j++) {
                const p1 = ourSurplus[ourSurplus.length - 1 - i]; // 2nd best (skip #1)
                const p2 = ourSurplus[ourSurplus.length - 1 - j]; // 3rd+ best
                if (containsAnchor([p1, p2], myCtx)) continue;
                // Depth guard: 2-for-1 removes 2 players — ensure enough remain
                const remainAfter2for1 = (myPlayersByPos[offerPos]?.length ?? 0) - 2;
                if (remainAfter2for1 < posMinDepth[offerPos]) continue;

                const totalOfferValue = (getPlayerValue(p1) + getPlayerValue(p2)) * getPosMultiplier(offerPos);
                const diff = totalOfferValue - targetValue;
                if (diff > 0 && diff < targetValue * 0.3) {
                  const evalResult = evaluateTrade({ teamACtx: myCtx, teamBCtx: otherCtx, aGivesPlayers: [p1, p2], aGivesPicks: [], bGivesPlayers: [target], bGivesPicks: [], personalValues: effectivePValues, lineupPointEstimates, teamARoster: myRoster.players, teamBRoster: otherRoster.players, leagueSettings });
                  // Directional check: 2-for-1 inherently costs a little, but cap at -15%
                  // Threshold lowered for 25% acceptance base (was 45)
                  if (evalResult.marketFairness > -15 && evalResult.acceptanceLikelihood > 25) {
                    ideas.push({
                      type: "2for1",
                      targetPlayer: target,
                      targetTeamId: otherRoster.teamId,
                      targetTeamName: otherRoster.teamName,
                      offeredPlayers: [p1, p2],
                      evalResult,
                      valueDiff: diff,
                      reason: `Consolidate depth: ${p1.name} + ${p2.name} → ${target.name}. (opponent fit ${Math.round(evalResult.acceptanceLikelihood)}/100)`,
                      priority: needLevel > 50 ? "high" : "medium",
                      acceptanceLikelihood: evalResult.acceptanceLikelihood,
                      verdictTone: evalResult.verdictForA.tone,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // ===== UPGRADE: sell depth at a position to upgrade your starter =====
    // The BUY loop skips same-position swaps. This loop specifically surfaces
    // "give your WR2/depth to get a better WR1" style moves.
    for (const upgradePos of (["QB", "RB", "WR", "TE"] as const)) {
      const myAtPos = myPlayersByPos[upgradePos] || []; // ascending sort
      if (myAtPos.length < 2) continue; // need depth to sell

      const myBest = myAtPos[myAtPos.length - 1];
      const myBestValue = getPlayerValue(myBest) * getPosMultiplier(upgradePos);

      for (const otherRoster of rosters) {
        if (otherRoster.teamId === myTeamId) continue;
        const otherCtxUpg = leagueCtx.get(otherRoster.teamId);
        if (!otherCtxUpg) continue;

        const theirAtPos = otherRoster.players
          .filter((p) => p.position === upgradePos)
          .sort((a, b) => getPlayerValue(b) - getPlayerValue(a));

        const theirNeedsUpg = calculatePositionalNeed(otherRoster.players, leagueSettings.rosterSlots, leagueSettings.superflex, effectivePValues);

        for (const target of theirAtPos.slice(0, 2)) {
          const targetValue = getPlayerValue(target) * getPosMultiplier(upgradePos);
          // Must be a genuine upgrade over my current best at this position
          if (targetValue <= myBestValue * 1.15) continue;
          if (targetValue < 30) continue;
          const targetProfileUpg = getAssetTimeProfile(upgradePos, target.age);
          if (leagueSettings.mode !== "redraft" && target.age > 31 && targetProfileUpg.futureFactor < 0.4) continue;

          // Offer candidates: my least-valuable at same pos, OR surplus at positions they need
          const offerCandidates: Player[] = [];
          if (myAtPos.length > (posMinDepth[upgradePos] ?? 1)) {
            offerCandidates.push(myAtPos[0]); // least valuable same-position depth
          }
          Object.entries(theirNeedsUpg)
            .filter(([pos, n]) => n > 20 && pos !== upgradePos)
            .forEach(([pos]) => {
              const surplus = myPlayersByPos[pos] || [];
              if (surplus.length > (posMinDepth[pos] ?? 1)) {
                offerCandidates.push(surplus[0]); // least valuable at their needed position
              }
            });

          for (const offer of offerCandidates) {
            if (!offer) continue;
            if (containsAnchor([offer], myCtx)) continue;
            const remainAfterUpg = (myPlayersByPos[offer.position]?.length ?? 0) - 1;
            if (remainAfterUpg < (posMinDepth[offer.position] ?? 1)) continue;

            const offerValue = getPlayerValue(offer) * getPosMultiplier(offer.position);
            if (offerValue < 15) continue;
            // Raw-value sanity: same guard as BUY loop — projection adjustments shouldn't hide a lopsided deal
            const rawOfferUpg = normalizeValue(offer.dynastyValue || DEFAULT_DYNASTY_VALUES[offer.name] || 0);
            const rawTargetUpg = normalizeValue(target.dynastyValue || DEFAULT_DYNASTY_VALUES[target.name] || 0);
            if (rawOfferUpg > rawTargetUpg * 1.20) continue;
            if (Math.abs(offerValue - targetValue) > targetValue * 0.35) continue;

            const evalResult = evaluateTrade({
              teamACtx: myCtx,
              teamBCtx: otherCtxUpg,
              aGivesPlayers: [offer],
              aGivesPicks: [],
              bGivesPlayers: [target],
              bGivesPicks: [],
              personalValues: effectivePValues,
              lineupPointEstimates,
              teamARoster: myRoster.players,
              teamBRoster: otherRoster.players,
              leagueSettings,
            });

            // Threshold lowered for 25% acceptance base (was 40)
            if (evalResult.marketFairness > -15 && evalResult.acceptanceLikelihood > 20) {
              const isSamePos = offer.position === upgradePos;
              ideas.push({
                type: "upgrade",
                targetPlayer: target,
                targetTeamId: otherRoster.teamId,
                targetTeamName: otherRoster.teamName,
                offeredPlayers: [offer],
                evalResult,
                valueDiff: offerValue - targetValue,
                reason: isSamePos
                  ? `Consolidate ${upgradePos} quality: give ${offer.name} (depth) to upgrade your starter to ${target.name}. ${evalResult.verdictForA.label}. (opponent fit ${Math.round(evalResult.acceptanceLikelihood)}/100)`
                  : `Trade ${offer.position} surplus for a ${upgradePos} quality upgrade. ${evalResult.verdictForA.label}. (opponent fit ${Math.round(evalResult.acceptanceLikelihood)}/100)`,
                priority: "medium",
                acceptanceLikelihood: evalResult.acceptanceLikelihood,
                verdictTone: evalResult.verdictForA.tone,
              });
            }
          }
        }
      }
    }


  return ideas;
}

export function generatePurePickCandidates(context: CandidateContext): TradeIdea[] {
  const {
    rosters, myTeamId, myRoster, myTeam: myCtx, league: leagueCtx,
    needs: myNeeds, effectiveValues: effectivePValues, leagueSettings, getPlayerValue,
    lineupPointEstimates,
  } = context;
  const ideas: TradeIdea[] = [];
    if (leagueSettings.mode === "redraft") return ideas;
    // ===== PURE PICK TRADES =====
    if (myRoster.draftPicks && myRoster.draftPicks.length > 0) {
      for (const otherRoster of rosters) {
        if (otherRoster.teamId === myTeamId) continue;
        const otherCtxPick = leagueCtx.get(otherRoster.teamId);
        if (!otherCtxPick) continue;
        for (const neededPos of Object.keys(myNeeds)) {
          if (myNeeds[neededPos] < 30) continue;
          const theirPlayers = otherRoster.players.filter((p) => p.position === neededPos).sort((a, b) => getPlayerValue(b) - getPlayerValue(a));
          for (const target of theirPlayers.slice(0, 3)) {
            const targetValue = getPlayerValue(target);
            // Don't offer picks for low-value players — not worth the capital.
            if (targetValue < 30) continue;
            // Don't spend picks on clearly declining veterans — same guard as buy/sweetener loops.
            const targetProfilePure = getAssetTimeProfile(target.position, target.age);
            if (target.age > 31 && targetProfilePure.futureFactor < 0.4) continue;
            // Find best pick combination (1-3 picks) that matches target value
            const pickCombos = findPickCombinations(
              myRoster.draftPicks,
              targetValue,
              3,  // Allow up to 3 picks
              0.35  // 35% tolerance
            );
            
            // Try the best combination (closest to target value)
            if (pickCombos.length > 0) {
              const bestCombo = pickCombos[0];
              const diff = bestCombo.totalValue - targetValue;
              
              const evalResult = evaluateTrade({
                teamACtx: myCtx,
                teamBCtx: otherCtxPick,
                aGivesPlayers: [],
                aGivesPicks: bestCombo.picks,
                bGivesPlayers: [target],
                bGivesPicks: [],
                personalValues: effectivePValues,
                lineupPointEstimates,
                teamARoster: myRoster.players,
                teamBRoster: otherRoster.players,
                leagueSettings,
              });
              
              // Threshold lowered for 25% acceptance base (was 35)
              if (evalResult.marketFairness > -10 && evalResult.acceptanceLikelihood > 15) {
                ideas.push({
                  type: "pick",
                  targetPlayer: target,
                  targetTeamId: otherRoster.teamId,
                  targetTeamName: otherRoster.teamName,
                  offeredPlayers: [],
                  offeredPicks: bestCombo.picks.map(p => ({ 
                    year: p.year, 
                    round: p.round, 
                    estimatedValue: p.estimatedValue 
                  })),
                  evalResult,
                  valueDiff: diff,
                  reason: `Offer ${bestCombo.description} (${bestCombo.totalValue.toFixed(0)} value) for ${target.name}. You need ${neededPos}.`,
                  priority: myNeeds[neededPos] > 50 ? "high" : "medium",
                  acceptanceLikelihood: evalResult.acceptanceLikelihood,
                  verdictTone: evalResult.verdictForA.tone,
                });
              }
            }
          }
        }
      }
    }

  return ideas;
}
