import type { SleeperDraft } from "@/lib/sleeper-api";

const draftStatusPriority: Record<string, number> = {
  drafting: 0,
  pre_draft: 1,
  complete: 2,
};

/** Select the most actionable draft for the league season deterministically. */
export function selectRelevantDraft(
  drafts: SleeperDraft[],
  leagueSeason?: string,
): SleeperDraft | undefined {
  if (drafts.length === 0) return undefined;

  const seasonDrafts = leagueSeason
    ? drafts.filter((draft) => draft.season === leagueSeason)
    : [];
  const candidates = seasonDrafts.length > 0 ? seasonDrafts : drafts;

  return [...candidates].sort((a, b) => {
    const seasonDifference = Number(b.season) - Number(a.season);
    if (Number.isFinite(seasonDifference) && seasonDifference !== 0) return seasonDifference;

    const statusDifference = (draftStatusPriority[a.status] ?? 3) - (draftStatusPriority[b.status] ?? 3);
    if (statusDifference !== 0) return statusDifference;

    return (b.start_time ?? 0) - (a.start_time ?? 0) || a.draft_id.localeCompare(b.draft_id);
  })[0];
}

/** Build roster ownership for each overall pick and reject incomplete draft data. */
export function buildDraftPickOrder(draft: SleeperDraft): number[] {
  const teams = draft.settings.teams;
  const rounds = draft.settings.rounds;
  if (!Number.isInteger(teams) || teams < 1 || !Number.isInteger(rounds) || rounds < 1) {
    throw new Error("Sleeper draft has invalid team or round settings");
  }

  const order: number[] = [];
  for (let round = 1; round <= rounds; round++) {
    const slots = Array.from({ length: teams }, (_, index) => index + 1);
    if (draft.type === "snake" && round % 2 === 0) slots.reverse();

    for (const slot of slots) {
      const rosterId = draft.slot_to_roster_id?.[String(slot)];
      if (!Number.isInteger(rosterId)) {
        throw new Error(`Sleeper draft is missing the roster for slot ${slot}`);
      }
      order.push(rosterId);
    }
  }

  return order;
}
