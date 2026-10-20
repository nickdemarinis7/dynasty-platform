import test from "node:test";
import assert from "node:assert/strict";
import { getPlayerValue } from "../src/lib/player-values.ts";
import { evaluateTradeLineupImpact, getLineupDisplay, optimizeLineup } from "../src/lib/lineup-optimizer.ts";
import { buildLeagueContext, evaluateTrade, packageAdjustedValue, type TeamContext } from "../src/lib/trade-engine.ts";
import { scoreRecommendation } from "../src/lib/recommendation-scoring.ts";
import { getEdgeScoreWeights } from "../src/lib/projection-mode.ts";
import { arePlayerStatsStale } from "../src/store/index.ts";
import type { LeagueSettings, Player } from "../src/types/index.ts";

const settings: LeagueSettings = {
  id: "test",
  name: "Test League",
  platform: "manual",
  mode: "dynasty",
  teamCount: 12,
  rosterSlots: [
    { type: "QB", count: 1 },
    { type: "RB", count: 1 },
    { type: "WR", count: 1 },
    { type: "FLEX", count: 1 },
    { type: "SUPERFLEX", count: 1 },
    { type: "BN", count: 5 },
  ],
  scoringType: "half_ppr",
  tePremium: false,
  tePremiumBonus: 0,
  superflex: true,
  taxiSquadSlots: 0,
  irSlots: 0,
};

function player(id: string, position: Player["position"], value: number): Player {
  return { id, name: id, position, team: "TEST", age: 26, dynastyValue: value };
}

function context(teamId: string): TeamContext {
  return {
    teamId,
    teamName: `Team ${teamId}`,
    totalValue: 500,
    starterValue: 300,
    leagueRank: 6,
    avgAge: 26,
    contentionScore: 0,
    winNowWeight: 0.5,
    windowLabel: "Balanced",
    windowColor: "text-gray-400",
    positionNeeds: { QB: 0, RB: 0, WR: 0, TE: 0 },
    pickCount: 3,
    pickCapital: 60,
    pickSurplusLabel: "normal",
    relativePositionRanks: { QB: 6, RB: 6, WR: 6, TE: 6 },
    deadZonePlayerIds: [],
    anchorPlayerIds: [],
    dynastyPowerScore: 50,
    rosterTopHeaviness: 0.3,
    totalTeams: 12,
  };
}

test("personal values allow an explicit zero override", () => {
  const asset = player("qb", "QB", 75);
  assert.equal(getPlayerValue(asset, { qb: 0 }), 0);
});

test("player stats freshness expires after the configured window", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  assert.equal(arePlayerStatsStale(null, now), true);
  assert.equal(arePlayerStatsStale(now - 5 * 60 * 60 * 1000, now), false);
  assert.equal(arePlayerStatsStale(now - 6 * 60 * 60 * 1000, now), true);
});

test("unknown zero-value players do not receive fallback points", () => {
  const lineup = optimizeLineup([player("unknown", "QB", 0)], settings);
  assert.equal(lineup.totalProjectedPoints, 0);
});

test("lineup display never assigns one player to multiple slots", () => {
  const roster = [
    player("qb1", "QB", 90),
    player("qb2", "QB", 75),
    player("rb1", "RB", 80),
    player("rb2", "RB", 65),
    player("wr1", "WR", 70),
  ];
  const assignedIds = getLineupDisplay(roster, settings)
    .flatMap((slot) => slot.player ? [slot.player.id] : []);

  assert.equal(new Set(assignedIds).size, assignedIds.length);
  assert.equal(assignedIds.length, 5);
});

test("trade impact remains finite for a zero-point starting lineup", () => {
  const result = evaluateTradeLineupImpact(
    [player("unknown", "QB", 0)],
    [],
    [],
    settings,
  );

  assert.equal(result.percentGain, 0);
  assert.ok(Number.isFinite(result.percentGain));
});

test("season point estimates drive lineup selection when weekly projections are unavailable", () => {
  const highMarketBackup = player("market-rb", "RB", 90);
  const productiveStarter = player("productive-rb", "RB", 45);
  const lineup = optimizeLineup(
    [highMarketBackup, productiveStarter],
    { ...settings, mode: "redraft", rosterSlots: [{ type: "RB", count: 1 }, { type: "BN", count: 1 }] },
    false,
    undefined,
    undefined,
    "half_ppr",
    { "market-rb": 6, "productive-rb": 15 },
  );

  assert.deepEqual(lineup.starters.map((starter) => starter.id), ["productive-rb"]);
  assert.equal(lineup.totalProjectedPoints, 15);
});

test("redraft context uses a current-season horizon and disables age sell signals", () => {
  const agingStarter = { ...player("aging-rb", "RB", 50), age: 29 };
  const rosters = [
    { teamId: "a", teamName: "A", ownerName: "A", players: [agingStarter], draftPicks: [] },
    { teamId: "b", teamName: "B", ownerName: "B", players: [player("young-rb", "RB", 40)], draftPicks: [] },
  ];
  const contexts = buildLeagueContext(rosters, { ...settings, mode: "redraft" }, {});

  assert.equal(contexts.get("a")?.winNowWeight, 1);
  assert.deepEqual(contexts.get("a")?.deadZonePlayerIds, []);
});

test("redraft Edge Score excludes career trajectory", () => {
  assert.deepEqual(getEdgeScoreWeights("redraft"), {
    trajectory: 0,
    production: 0.6,
    teamFit: 0.4,
  });
  assert.equal(getEdgeScoreWeights("dynasty").trajectory, 0.35);
});

test("equal market assets produce neutral market fairness", () => {
  const result = evaluateTrade({
    teamACtx: context("a"),
    teamBCtx: context("b"),
    aGivesPlayers: [player("a-wr", "WR", 50)],
    aGivesPicks: [],
    bGivesPlayers: [player("b-wr", "WR", 50)],
    bGivesPicks: [],
    personalValues: {},
  });

  assert.equal(result.marketFairness, 0);
  assert.equal(result.marketA, result.marketB);
});

test("opponent fit score rises when the opponent receives more market value", () => {
  const base = {
    teamACtx: context("a"),
    teamBCtx: context("b"),
    aGivesPicks: [],
    bGivesPicks: [],
    personalValues: {},
  };
  const even = evaluateTrade({
    ...base,
    aGivesPlayers: [player("a-even", "WR", 50)],
    bGivesPlayers: [player("b-even", "WR", 50)],
  });
  const opponentFavored = evaluateTrade({
    ...base,
    aGivesPlayers: [player("a-premium", "WR", 70)],
    bGivesPlayers: [player("b-return", "WR", 40)],
  });

  assert.ok(opponentFavored.acceptanceLikelihood > even.acceptanceLikelihood);
  assert.ok(opponentFavored.acceptanceLikelihood <= 100);
  assert.ok(opponentFavored.marketFairness < 0);
});

test("recommendation quality rewards a market gain and penalizes an overpay", () => {
  const shared = {
    positionalFit: 60,
    acceptanceLikelihood: 50,
    windowAlignment: 60,
    urgency: 50,
  };
  const gain = scoreRecommendation({ ...shared, valueGain: 20 });
  const overpay = scoreRecommendation({ ...shared, valueGain: -20 });

  assert.ok(gain.compositeScore > overpay.compositeScore);
});

test("multi-asset packages receive a consolidation discount", () => {
  assert.equal(packageAdjustedValue([60]), 60);
  assert.equal(packageAdjustedValue([30, 30]), 57);
  assert.ok(packageAdjustedValue([20, 20, 20]) < 60);
});

test("trade lineup impact uses weekly projections when supplied", () => {
  const oldQb = player("old-qb", "QB", 50);
  const newQb = player("new-qb", "QB", 50);
  const result = evaluateTrade({
    teamACtx: context("a"),
    teamBCtx: context("b"),
    aGivesPlayers: [oldQb],
    aGivesPicks: [],
    bGivesPlayers: [newQb],
    bGivesPicks: [],
    personalValues: {},
    teamARoster: [oldQb],
    leagueSettings: settings,
    currentWeek: 5,
    projections: {
      "old-qb": {
        player_id: "old-qb", week: 5, season: "2026", season_type: "regular",
        status: null, date: "", category: "", stats: { pts_half_ppr: 10 },
      },
      "new-qb": {
        player_id: "new-qb", week: 5, season: "2026", season_type: "regular",
        status: null, date: "", category: "", stats: { pts_half_ppr: 20 },
      },
    },
  });

  assert.equal(result.lineupImpactA?.source, "weekly_projection");
  assert.equal(result.lineupImpactA?.pointsGained, 10);
});
