import test from "node:test";
import assert from "node:assert/strict";
import { parseFantasyCalcResponse } from "../src/lib/fantasycalc.ts";
import {
  getCurrentNFLSeason,
  findSleeperRosterForUser,
  getSleeperLeagueMode,
  parseSleeperLeague,
  parseSleeperLeagueList,
  parseSleeperLeagueUsers,
  parseSleeperNFLState,
  parseSleeperRosters,
  parseSleeperUser,
} from "../src/lib/sleeper-api.ts";

test("Sleeper NFL state parser normalizes week and season type", () => {
  assert.deepEqual(parseSleeperNFLState({ season: "2026", week: 22, season_type: "post" }), {
    season: "2026", week: 18, season_type: "post",
  });
  assert.deepEqual(parseSleeperNFLState({ season: "2026", week: 0, season_type: "unexpected" }), {
    season: "2026", week: 1, season_type: "regular",
  });
});

test("Sleeper NFL state parser rejects missing and non-finite fields", () => {
  assert.throws(() => parseSleeperNFLState(null), /invalid NFL state/i);
  assert.throws(() => parseSleeperNFLState({ season: "26", week: 1 }), /valid season/i);
  assert.throws(() => parseSleeperNFLState({ season: "2026", week: Number.NaN }), /valid week/i);
});

test("Sleeper user parser requires stable identity fields", () => {
  assert.equal(parseSleeperUser({ user_id: "1", username: "manager" }).user_id, "1");
  assert.throws(() => parseSleeperUser({ username: "manager" }), /required fields/i);
});

test("Sleeper league parsers reject partial leagues and invalid lists", () => {
  const validLeague = {
    league_id: "123", name: "Dynasty", total_rosters: 12, roster_positions: ["QB", "RB", "WR"],
  };
  assert.equal(parseSleeperLeague(validLeague).league_id, "123");
  assert.equal(parseSleeperLeagueList([validLeague]).length, 1);
  assert.throws(() => parseSleeperLeague({ league_id: "123", name: "Dynasty" }), /roster positions/i);
  assert.throws(() => parseSleeperLeagueList({ leagues: [] }), /league list/i);
});

test("Sleeper league type maps to a persistent app mode", () => {
  const base = {
    league_id: "123", name: "League", total_rosters: 12, roster_positions: ["QB"],
    scoring_settings: {}, settings: {},
  };
  assert.equal(getSleeperLeagueMode({ ...base, settings: { type: 2 } }), "dynasty");
  assert.equal(getSleeperLeagueMode({ ...base, settings: { type: 1 } }), "keeper");
  assert.equal(getSleeperLeagueMode(base), "redraft");
});

test("Sleeper roster parser normalizes orphaned and empty rosters", () => {
  const valid = { roster_id: 1, owner_id: "owner", players: ["p1"], starters: ["p1"] };
  assert.deepEqual(parseSleeperRosters([valid]), [valid]);
  assert.deepEqual(
    parseSleeperRosters([{ roster_id: 2, owner_id: null, players: null, starters: null }]),
    [{ roster_id: 2, owner_id: null, players: [], starters: [] }],
  );
  assert.throws(() => parseSleeperRosters([{ ...valid, owner_id: 3 }]), /owner ID/i);
  assert.throws(() => parseSleeperRosters([{ ...valid, players: "p1" }]), /player list/i);
  assert.throws(() => parseSleeperRosters([{ ...valid, players: [1] }]), /player list/i);
});

test("Sleeper roster ownership never falls back to another manager's team", () => {
  const rosters = parseSleeperRosters([
    { roster_id: 1, owner_id: "owner-1", players: [], starters: [] },
    { roster_id: 2, owner_id: null, players: [], starters: [] },
  ]);

  assert.equal(findSleeperRosterForUser(rosters, "owner-1")?.roster_id, 1);
  assert.equal(findSleeperRosterForUser(rosters, "missing-owner"), undefined);
});

test("league-user parsing tolerates missing profiles and drops invalid identities", () => {
  const users = parseSleeperLeagueUsers([
    { user_id: "owner-1", display_name: "Manager" },
    { display_name: "Missing ID" },
    null,
  ]);
  assert.equal(users.length, 1);
  assert.equal(users[0].username, "Unknown");
  assert.equal(users[0].display_name, "Manager");
});

test("FantasyCalc parser rejects provider error bodies and filters malformed entries", () => {
  assert.throws(() => parseFantasyCalcResponse(null), /invalid response/i);
  assert.throws(() => parseFantasyCalcResponse({ error: "rate limited" }), /invalid response/i);
  assert.throws(() => parseFantasyCalcResponse([null, { value: 50 }]), /no valid values/i);

  const valid = {
    player: { id: 1, name: "Player One", mflId: "", sleeperId: "p1", position: "WR", maybeAge: 24, maybeTeam: "BUF" },
    value: 5000, overallRank: 10, positionRank: 5, trend30Day: 100, redraftValue: 3000, maybeTier: 2,
  };
  assert.deepEqual(parseFantasyCalcResponse([null, valid, { player: {}, value: 10 }]), [valid]);
  assert.throws(
    () => parseFantasyCalcResponse([{ ...valid, value: Number.NaN }]),
    /no valid values/i,
  );
});

test("calendar season fallback uses the prior season in January and February", () => {
  assert.equal(getCurrentNFLSeason(new Date("2026-01-15T12:00:00Z")), "2025");
  assert.equal(getCurrentNFLSeason(new Date("2026-09-15T12:00:00Z")), "2026");
});
