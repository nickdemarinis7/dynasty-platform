import test from "node:test";
import assert from "node:assert/strict";
import { recommendationTradeParams } from "../src/lib/recommendations/navigation.ts";
import { rankRecommendations } from "../src/lib/recommendations/ranking.ts";
import { getRecommendationEmptyState } from "../src/lib/recommendations/empty-state.ts";
import { isQualityRecommendation } from "../src/lib/recommendations/quality.ts";
import { hasUsefulLineupImpact } from "../src/lib/recommendations/pipeline.ts";
import { scoreRecommendation } from "../src/lib/recommendation-scoring.ts";
import { containsAnchor, generateBuyLowCandidates, type CandidateContext } from "../src/lib/recommendations/candidates.ts";
import { applyRecommendationToRoster, buildStrategicPlan, strategicStepHeadline } from "../src/lib/recommendations/strategic-plan.ts";
import type { TeamContext } from "../src/lib/trade-engine.ts";
import type { LeagueSettings, TeamRoster } from "../src/types/index.ts";
import type { TradeIdea, TradeType } from "../src/lib/recommendations/types.ts";
import type { SmartTradeResult } from "../src/lib/trade-engine.ts";
import type { Player } from "../src/types/index.ts";

function player(id: string, position: Player["position"] = "WR"): Player {
  return { id, name: id, position, team: "TEST", age: 25, dynastyValue: 50 };
}

function idea(overrides: Partial<TradeIdea> & { type?: TradeType } = {}): TradeIdea {
  return {
    type: "buy",
    targetPlayer: player("target"),
    targetTeamId: "team-b",
    targetTeamName: "Team B",
    offeredPlayers: [player("offer", "RB")],
    valueDiff: 0,
    reason: "fixture",
    priority: "medium",
    acceptanceLikelihood: 50,
    verdictTone: "fair",
    compositeScore: 50,
    ...overrides,
  };
}

test("recommendation handoff serializes players and picks on the correct sides", () => {
  const params = recommendationTradeParams(idea({
    offeredPlayers: [player("offer-1"), player("offer-2")],
    offeredPicks: [{ year: 2027, round: 2, estimatedValue: 20 }],
  }), "team-a");

  assert.equal(params.get("teamA"), "team-a");
  assert.equal(params.get("teamB"), "team-b");
  assert.equal(params.get("playersA"), "offer-1,offer-2");
  assert.equal(params.get("playersB"), "target");
  assert.equal(params.get("picksA"), "2027-2");
  assert.equal(params.get("source"), "recommendation");
});

test("sell-for-picks handoff places the player on A and received picks on B", () => {
  const params = recommendationTradeParams(idea({
    type: "sell",
    targetPlayer: player("veteran", "RB"),
    offeredPlayers: [],
    receivingPicks: [
      { year: 2027, round: 1, estimatedValue: 40 },
      { year: 2028, round: 2, estimatedValue: 20 },
    ],
  }), "team-a");

  assert.equal(params.get("playersA"), "veteran");
  assert.equal(params.get("playersB"), null);
  assert.equal(params.get("picksB"), "2027-1,2028-2");
});

test("recommendation ranking is deterministic and removes duplicate targets", () => {
  const lower = idea({ compositeScore: 60, acceptanceLikelihood: 80 });
  const duplicateHigher = idea({ compositeScore: 80, acceptanceLikelihood: 30 });
  const other = idea({
    targetPlayer: player("other", "QB"),
    compositeScore: 70,
  });

  const ranked = rankRecommendations([lower, other, duplicateHigher]);
  assert.deepEqual(ranked.map((result) => result.targetPlayer.id), ["target", "other"]);
  assert.equal(ranked[0].compositeScore, 80);
});

test("position focus returns acquisitions only", () => {
  const qbBuy = idea({ targetPlayer: player("qb", "QB") });
  const wrBuy = idea({ targetPlayer: player("wr", "WR") });
  const qbSell = idea({ type: "sell", targetPlayer: player("sell-qb", "QB") });

  const focused = rankRecommendations([wrBuy, qbSell, qbBuy], { focusedPosition: "QB" });
  assert.deepEqual(focused.map((result) => result.targetPlayer.id), ["qb"]);
});

test("position focus is applied before the result limit", () => {
  const higherRankedReceivers = Array.from({ length: 20 }, (_, index) => idea({
    targetPlayer: player(`wr-${index}`, "WR"),
    targetTeamId: `team-${index}`,
    compositeScore: 90 - index,
  }));
  const quarterback = idea({
    targetPlayer: player("needed-qb", "QB"),
    targetTeamId: "qb-team",
    compositeScore: 40,
  });

  const focused = rankRecommendations([...higherRankedReceivers, quarterback], {
    focusedPosition: "QB",
    limit: 15,
  });
  assert.deepEqual(focused.map((result) => result.targetPlayer.id), ["needed-qb"]);
});

test("empty-state diagnostics distinguish candidate and quality failures", () => {
  const noCandidates = getRecommendationEmptyState({
    candidateCount: 0, evaluatedCount: 0, rankedCount: 0, focusedPosition: null,
  });
  const rejected = getRecommendationEmptyState({
    candidateCount: 7, evaluatedCount: 0, rankedCount: 0, focusedPosition: null,
  });

  assert.equal(noCandidates.reason, "no-candidates");
  assert.equal(noCandidates.action, "player-values");
  assert.equal(rejected.reason, "quality-safeguards");
  assert.match(rejected.description, /7 potential packages/);
});

test("empty-state diagnostics prioritize position focus and recover from UI filters", () => {
  const focused = getRecommendationEmptyState({
    candidateCount: 8, evaluatedCount: 4, rankedCount: 0, focusedPosition: "TE",
  });
  const filtered = getRecommendationEmptyState({
    candidateCount: 8, evaluatedCount: 4, rankedCount: 4, focusedPosition: null,
  });

  assert.equal(focused.reason, "focused-position");
  assert.match(focused.title, /TE upgrades/);
  assert.equal(filtered.reason, "active-filters");
  assert.equal(filtered.action, "clear-filters");
});

test("quality gate rejects low-fit overpays but still permits sell exits", () => {
  const scoreFactors = {
    valueGain: -20,
    positionalFit: 50,
    acceptanceLikelihood: 20,
    windowAlignment: 50,
    urgency: 50,
  };
  const overpay = idea({
    acceptanceLikelihood: 20,
    compositeScore: 60,
    scoreFactors,
    scoreExplanation: "fixture score",
  });
  const sellExit = idea({
    ...overpay,
    type: "sell",
  });

  assert.equal(isQualityRecommendation(overpay), false);
  assert.equal(isQualityRecommendation(sellExit), true);
});

test("redraft scoring removes timeline alignment from the recommendation", () => {
  const scored = scoreRecommendation({
    valueGain: 0,
    positionalFit: 70,
    acceptanceLikelihood: 60,
    windowAlignment: 100,
    urgency: 80,
  }, "redraft");

  assert.doesNotMatch(scored.explanation, /Timelines align/);
});

test("lineup gate rejects acquisition downgrades without blocking sell exits", () => {
  const downgradeResult = {
    lineupImpactA: {
      recommendation: "downgrade",
      pointsGained: -2,
      receivedPlayerStarts: false,
    },
  } as unknown as SmartTradeResult;
  const acquisition = idea({ evalResult: downgradeResult });
  const sell = idea({ type: "sell", evalResult: downgradeResult });

  assert.equal(hasUsefulLineupImpact(acquisition), false);
  assert.equal(hasUsefulLineupImpact(sell), true);
});

test("buy-low generation requires a meaningful personal-value edge", () => {
  const target = player("target");
  target.dynastyValue = 40;
  const rosters = [
    { teamId: "mine", teamName: "Mine", ownerName: "Me", players: [], draftPicks: [] },
    { teamId: "other", teamName: "Other", ownerName: "Them", players: [target], draftPicks: [] },
  ];
  const base = { rosters, myTeamId: "mine" };

  const noEdge = generateBuyLowCandidates({ ...base, personalValues: { target: 45 }, lineupPointEstimates: {} } as unknown as CandidateContext);
  const edge = generateBuyLowCandidates({ ...base, personalValues: { target: 55 }, lineupPointEstimates: {} } as unknown as CandidateContext);

  assert.equal(noEdge.length, 0);
  assert.equal(edge.length, 1);
  assert.equal(edge[0].targetPlayer.id, "target");
});

test("candidate packages protect every anchor asset", () => {
  const anchor = player("anchor", "QB");
  const depth = player("depth", "WR");
  const team = { anchorPlayerIds: [anchor.id] } as TeamContext;

  assert.equal(containsAnchor([depth], team), false);
  assert.equal(containsAnchor([depth, anchor], team), true);
});

test("strategic planning produces a team summary and actionable fallback", () => {
  const settings: LeagueSettings = {
    id: "league", name: "League", platform: "manual", mode: "dynasty", teamCount: 2,
    rosterSlots: [
      { type: "QB", count: 1 }, { type: "RB", count: 1 },
      { type: "WR", count: 1 }, { type: "TE", count: 1 }, { type: "BN", count: 4 },
    ],
    scoringType: "half_ppr", tePremium: false, tePremiumBonus: 0,
    superflex: false, taxiSquadSlots: 0, irSlots: 0,
  };
  const roster = (teamId: string, prefix: string): TeamRoster => ({
    teamId, teamName: teamId, ownerName: teamId, draftPicks: [],
    players: [
      player(`${prefix}-qb`, "QB"), player(`${prefix}-rb1`, "RB"),
      player(`${prefix}-rb2`, "RB"), player(`${prefix}-wr1`, "WR"),
      player(`${prefix}-wr2`, "WR"), player(`${prefix}-te`, "TE"),
    ],
  });
  const mine = roster("mine", "a");
  const plan = buildStrategicPlan({
    recommendations: [], myRoster: mine, leagueSettings: settings,
    personalValues: {}, rosters: [mine, roster("other", "b")], myTeamId: "mine",
    projectionAdjustedValues: {}, getPlayerValue: (asset) => asset.dynastyValue,
  });

  assert.ok(plan);
  assert.equal(plan.teamSummary.totalTeams, 2);
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.steps[0].headline.length > 0);
});

test("sell-for-picks planning removes the player and names the pick return", () => {
  const veteran = player("veteran", "RB");
  const teammate = player("teammate", "WR");
  const sellForPicks = idea({
    type: "sell",
    targetPlayer: veteran,
    offeredPlayers: [veteran],
    receivingPicks: [
      { year: 2027, round: 1, estimatedValue: 40 },
      { year: 2028, round: 2, estimatedValue: 20 },
    ],
  });

  const result = applyRecommendationToRoster([veteran, teammate], sellForPicks, "sell");
  assert.deepEqual(result.map((asset) => asset.id), ["teammate"]);
  assert.equal(strategicStepHeadline(sellForPicks, "sell"), "Sell veteran → 2027 R1 + 2028 R2");
});

test("player-for-player sell simulation replaces the outgoing player", () => {
  const veteran = player("veteran", "RB");
  const prospect = player("prospect", "WR");
  const swap = idea({
    type: "sell", targetPlayer: prospect, offeredPlayers: [veteran],
  });

  const result = applyRecommendationToRoster([veteran], swap, "sell");
  assert.deepEqual(result.map((asset) => asset.id), ["prospect"]);
  assert.equal(strategicStepHeadline(swap, "sell"), "Sell veteran → Get prospect");
});
