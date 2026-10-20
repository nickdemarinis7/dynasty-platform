import test from "node:test";
import assert from "node:assert/strict";
import { buildDraftPickOrder, selectRelevantDraft } from "../src/lib/draft-utils.ts";
import type { SleeperDraft } from "../src/lib/sleeper-api.ts";

function draft(overrides: Partial<SleeperDraft> = {}): SleeperDraft {
  return {
    draft_id: "draft-1",
    status: "pre_draft",
    type: "linear",
    season: "2026",
    settings: { rounds: 2, teams: 3 },
    slot_to_roster_id: { "1": 11, "2": 22, "3": 33 },
    draft_order: null,
    ...overrides,
  };
}

test("draft selection prefers the league season and actionable status", () => {
  const selected = selectRelevantDraft([
    draft({ draft_id: "future", season: "2027", status: "pre_draft" }),
    draft({ draft_id: "complete", status: "complete", start_time: 300 }),
    draft({ draft_id: "active", status: "drafting", start_time: 100 }),
  ], "2026");

  assert.equal(selected?.draft_id, "active");
});

test("draft selection falls back to the newest available season", () => {
  const selected = selectRelevantDraft([
    draft({ draft_id: "old", season: "2025" }),
    draft({ draft_id: "new", season: "2027" }),
  ], "2026");

  assert.equal(selected?.draft_id, "new");
  assert.equal(selectRelevantDraft([], "2026"), undefined);
});

test("pick order handles linear and snake drafts", () => {
  assert.deepEqual(buildDraftPickOrder(draft()), [11, 22, 33, 11, 22, 33]);
  assert.deepEqual(buildDraftPickOrder(draft({ type: "snake" })), [11, 22, 33, 33, 22, 11]);
});

test("pick order rejects incomplete Sleeper slot mappings", () => {
  assert.throws(
    () => buildDraftPickOrder(draft({ slot_to_roster_id: { "1": 11, "2": 22 } })),
    /missing the roster for slot 3/i,
  );
});
