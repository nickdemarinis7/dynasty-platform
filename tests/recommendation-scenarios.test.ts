import test from "node:test";
import assert from "node:assert/strict";
import { calculatePositionalNeed } from "../src/lib/player-values.ts";
import {
  generatePurePickCandidates,
  generateRecommendationCandidates,
  type CandidateContext,
} from "../src/lib/recommendations/candidates.ts";
import { buildLeagueContext } from "../src/lib/trade-engine.ts";
import type { DraftPick, LeagueSettings, Player, TeamRoster } from "../src/types/index.ts";

function asset(id: string, position: Player["position"], value: number, age = 25): Player {
  return { id, name: id, position, team: "TST", age, dynastyValue: value };
}

function pick(year: number, round: number, value: number, owner: string): DraftPick {
  return { year, round, estimatedValue: value, originalOwner: owner, currentOwner: owner };
}

function settings(overrides: Partial<LeagueSettings> = {}): LeagueSettings {
  return {
    id: "fixture", name: "Fixture League", platform: "manual", mode: "dynasty", teamCount: 3,
    rosterSlots: [
      { type: "QB", count: 1 }, { type: "RB", count: 2 },
      { type: "WR", count: 2 }, { type: "TE", count: 1 },
      { type: "FLEX", count: 1 }, { type: "BN", count: 5 },
    ],
    scoringType: "half_ppr", tePremium: false, tePremiumBonus: 0,
    superflex: false, taxiSquadSlots: 0, irSlots: 0,
    ...overrides,
  };
}

function roster(teamId: string, players: Player[], picks: DraftPick[] = []): TeamRoster {
  return { teamId, teamName: `Team ${teamId}`, ownerName: `Owner ${teamId}`, players, draftPicks: picks };
}

function candidateContext(
  rosters: TeamRoster[],
  leagueSettings: LeagueSettings,
  personalValues: Record<string, number> = {},
): CandidateContext {
  const myRoster = rosters[0];
  const values = { ...personalValues };
  const league = buildLeagueContext(rosters, leagueSettings, values);
  const myTeam = league.get(myRoster.teamId);
  assert.ok(myTeam);
  return {
    rosters, myTeamId: myRoster.teamId, myRoster, myTeam, league,
    needs: calculatePositionalNeed(myRoster.players, leagueSettings.rosterSlots, leagueSettings.superflex, values),
    projections: {}, lineupPointEstimates: {}, personalValues, effectiveValues: values, leagueSettings,
    getPlayerValue: (player) => personalValues[player.id] ?? player.dynastyValue,
  };
}

const noRoadmap = () => [];

test("rebuild fixture protects cornerstone assets across complete generation", () => {
  const leagueSettings = settings({
    superflex: true,
    rosterSlots: [
      { type: "QB", count: 1 }, { type: "SUPERFLEX", count: 1 },
      { type: "RB", count: 2 }, { type: "WR", count: 2 },
      { type: "TE", count: 1 }, { type: "BN", count: 6 },
    ],
  });
  const mine = roster("mine", [
    asset("anchor-qb", "QB", 90, 24), asset("qb2", "QB", 45, 27),
    asset("old-rb", "RB", 55, 29), asset("rb2", "RB", 30, 24), asset("rb3", "RB", 22, 23),
    asset("wr1", "WR", 45, 25), asset("wr2", "WR", 35, 24), asset("te1", "TE", 25, 25),
  ], [pick(2027, 1, 40, "mine")]);
  const partner = roster("partner", [
    asset("p-qb1", "QB", 55, 29), asset("p-qb2", "QB", 35, 28),
    asset("young-rb", "RB", 42, 21), asset("p-rb2", "RB", 25, 25),
    asset("young-wr", "WR", 50, 22), asset("p-wr2", "WR", 25, 26), asset("p-te", "TE", 30, 26),
  ], [pick(2028, 1, 38, "partner")]);
  const third = roster("third", [
    asset("t-qb1", "QB", 50), asset("t-qb2", "QB", 40), asset("t-rb1", "RB", 40),
    asset("t-rb2", "RB", 35), asset("t-wr1", "WR", 45), asset("t-wr2", "WR", 35), asset("t-te", "TE", 30),
  ]);

  const context = candidateContext([mine, partner, third], leagueSettings);
  const ideas = generateRecommendationCandidates(context, null, noRoadmap);
  assert.ok(context.myTeam.anchorPlayerIds.includes("anchor-qb"));
  assert.ok(ideas.every((idea) => idea.offeredPlayers.every((player) => player.id !== "anchor-qb")));
});

test("contender fixture never targets clearly declining veterans", () => {
  const leagueSettings = settings();
  const mine = roster("mine", [
    asset("qb", "QB", 60), asset("rb1", "RB", 55), asset("rb2", "RB", 45), asset("rb3", "RB", 35),
    asset("wr1", "WR", 35), asset("wr2", "WR", 25), asset("te", "TE", 30),
  ]);
  const other = roster("other", [
    asset("other-qb", "QB", 40), asset("other-rb1", "RB", 30), asset("other-rb2", "RB", 25),
    asset("old-wr", "WR", 65, 34), asset("prime-wr", "WR", 60, 26), asset("other-te", "TE", 30),
  ]);
  const third = roster("third", [asset("t-qb", "QB", 40), asset("t-rb1", "RB", 35), asset("t-rb2", "RB", 30), asset("t-wr1", "WR", 40), asset("t-wr2", "WR", 35), asset("t-te", "TE", 25)]);

  const ideas = generateRecommendationCandidates(candidateContext([mine, other, third], leagueSettings), null, noRoadmap);
  assert.ok(ideas.every((idea) => idea.type === "sell" || idea.targetPlayer.id !== "old-wr"));
});

test("TE-premium fixture increases TE need relative to the same standard roster", () => {
  const players = [asset("qb", "QB", 55), asset("rb1", "RB", 45), asset("rb2", "RB", 40), asset("wr1", "WR", 50), asset("wr2", "WR", 45), asset("te", "TE", 20)];
  const standard = settings();
  const premium = settings({ tePremium: true, tePremiumBonus: 0.5 });
  const standardNeed = calculatePositionalNeed(players, standard.rosterSlots, false, {}).TE;
  const premiumNeed = calculatePositionalNeed(players, premium.rosterSlots, false, {}).TE;
  assert.ok(premiumNeed >= standardNeed);
});

test("pick-heavy fixture can construct a pure-pick acquisition", () => {
  const leagueSettings = settings();
  const mine = roster("mine", [
    asset("qb", "QB", 55), asset("rb1", "RB", 45), asset("rb2", "RB", 40),
    asset("wr1", "WR", 20), asset("te", "TE", 25),
  ], [pick(2027, 1, 45, "mine"), pick(2027, 2, 20, "mine")]);
  const other = roster("other", [
    asset("o-qb", "QB", 12, 22), asset("o-rb1", "RB", 10, 21), asset("o-rb2", "RB", 8, 21),
    asset("target-wr", "WR", 42, 22), asset("o-wr2", "WR", 10, 21), asset("o-te", "TE", 8, 22),
  ]);
  const third = roster("third", [asset("t-qb", "QB", 70), asset("t-rb1", "RB", 65), asset("t-rb2", "RB", 60), asset("t-wr1", "WR", 70), asset("t-wr2", "WR", 60), asset("t-te", "TE", 55)]);

  const ideas = generatePurePickCandidates(candidateContext([mine, other, third], leagueSettings));
  assert.ok(ideas.some((idea) => idea.type === "pick" && idea.targetPlayer.id === "target-wr" && (idea.offeredPicks?.length ?? 0) > 0));
});

test("personal-value fixture produces buy-low candidates only beyond the edge threshold", () => {
  const leagueSettings = settings();
  const mine = roster("mine", []);
  const target = asset("target", "WR", 40);
  const other = roster("other", [target]);
  const third = roster("third", []);
  const ideas = generateRecommendationCandidates(
    candidateContext([mine, other, third], leagueSettings, { target: 55 }),
    null,
    noRoadmap,
  );
  assert.ok(ideas.some((idea) => idea.type === "buy-low" && idea.targetPlayer.id === "target"));
});

test("redraft generation excludes dynasty sell-high and future-pick strategies", () => {
  const leagueSettings = settings({ mode: "redraft" });
  const mine = roster("mine", [
    asset("qb", "QB", 50), asset("old-rb", "RB", 55, 30),
    asset("rb2", "RB", 35), asset("wr1", "WR", 40), asset("wr2", "WR", 30), asset("te", "TE", 25),
  ], [pick(2027, 1, 45, "mine")]);
  const other = roster("other", [
    asset("o-qb", "QB", 45), asset("young-rb", "RB", 45, 22),
    asset("o-rb2", "RB", 30), asset("o-wr1", "WR", 45), asset("o-wr2", "WR", 35), asset("o-te", "TE", 30),
  ]);

  const ideas = generateRecommendationCandidates(
    candidateContext([mine, other], leagueSettings), null, noRoadmap,
  );
  assert.ok(ideas.every((idea) => idea.type !== "sell" && idea.type !== "pick"));
});
