// FantasyCalc API integration - real dynasty values sourced from ~1M fantasy trades
// Values are keyed by Sleeper player ID for direct roster mapping.

const FANTASYCALC_BASE_URL = "https://api.fantasycalc.com/values/current";

export interface FantasyCalcPlayer {
  player: {
    id: number;
    name: string;
    mflId: string;
    sleeperId: string;
    position: string;
    maybeAge: number | null;
    maybeTeam: string | null;
  };
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day: number;
  redraftValue: number;
  maybeTier: number | null;
}

export interface FantasyCalcValueEntry {
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day: number;
  redraftValue: number;
  tier: number | null;
  name: string;
  position: string;
  age: number | null;
  team: string | null;
}

export interface FetchValuesParams {
  isDynasty?: boolean;
  numQbs?: number; // 1 = standard, 2 = superflex
  numTeams?: number;
  ppr?: number; // 0 = standard, 0.5 = half, 1 = full
}

export interface FantasyCalcData {
  bySleeperId: Record<string, FantasyCalcValueEntry>;
  byName: Record<string, FantasyCalcValueEntry>;
  picks: PickValueLookup;
  fetchedAt: number;
}

export function isFantasyCalcPlayer(value: unknown): value is FantasyCalcPlayer {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!item.player || typeof item.player !== "object" || typeof item.value !== "number" || !Number.isFinite(item.value)) return false;
  const player = item.player as Record<string, unknown>;
  return typeof player.name === "string" && player.name.length > 0 &&
    typeof player.position === "string" && player.position.length > 0 &&
    typeof item.overallRank === "number" && Number.isFinite(item.overallRank) &&
    typeof item.positionRank === "number" && Number.isFinite(item.positionRank) &&
    typeof item.trend30Day === "number" && Number.isFinite(item.trend30Day) &&
    typeof item.redraftValue === "number" && Number.isFinite(item.redraftValue);
}

export function parseFantasyCalcResponse(payload: unknown): FantasyCalcPlayer[] {
  if (!Array.isArray(payload)) throw new Error("FantasyCalc returned an invalid response");
  const valid = payload.filter(isFantasyCalcPlayer);
  if (valid.length === 0) throw new Error("FantasyCalc returned no valid values");
  return valid;
}

async function fetchFantasyCalc(params: FetchValuesParams): Promise<FantasyCalcPlayer[]> {
  const { isDynasty = true, numQbs = 2, numTeams = 12, ppr = 1 } = params;
  const url = `${FANTASYCALC_BASE_URL}?isDynasty=${isDynasty}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
  const res = await fetch(url, { next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`FantasyCalc API error: ${res.status}`);
  return parseFantasyCalcResponse(await res.json());
}

export async function getFantasyCalcData(params: FetchValuesParams = {}): Promise<FantasyCalcData> {
  const data = await fetchFantasyCalc(params);
  const bySleeperId: Record<string, FantasyCalcValueEntry> = {};
  const byName: Record<string, FantasyCalcValueEntry> = {};
  const named: Record<string, number> = {};
  const generic: Record<string, number> = {};

  for (const item of data) {
    if (item.player.position === "PICK") {
      const convertedValue = Math.round(item.value / 100);
      const namedMatch = item.player.name.match(/^(\d{4})\s+Pick\s+(\d+)\.(\d+)$/);
      if (namedMatch) {
        const [, year, round, slot] = namedMatch;
        named[`${year}-${Number(round)}-${Number(slot)}`] = convertedValue;
      }
      const genericMatch = item.player.name.match(/^(\d{4})\s+(1st|2nd|3rd|4th)$/);
      if (genericMatch) {
        const [, year, suffix] = genericMatch;
        const round = Object.entries(ROUND_SUFFIX).find(([, candidate]) => candidate === suffix)?.[0];
        if (round) generic[`${year}-${round}`] = convertedValue;
      }
      continue;
    }

    const entry: FantasyCalcValueEntry = {
      value: Math.round(item.value / 100),
      overallRank: item.overallRank,
      positionRank: item.positionRank,
      trend30Day: Math.round(item.trend30Day / 100),
      redraftValue: Math.round(item.redraftValue / 100),
      tier: item.maybeTier,
      name: item.player.name,
      position: item.player.position,
      age: item.player.maybeAge,
      team: item.player.maybeTeam,
    };
    if (item.player.sleeperId) bySleeperId[item.player.sleeperId] = entry;
    byName[normalizeName(item.player.name)] = entry;
  }

  return { bySleeperId, byName, picks: { named, generic }, fetchedAt: Date.now() };
}

/**
 * Fetches current dynasty values from FantasyCalc.
 * Returns a map keyed by Sleeper player ID for direct roster mapping,
 * plus a fallback map keyed by lowercased player name.
 */
export async function getFantasyCalcValues(
  params: FetchValuesParams = {}
): Promise<{
  bySleeperId: Record<string, FantasyCalcValueEntry>;
  byName: Record<string, FantasyCalcValueEntry>;
}> {
  const { bySleeperId, byName } = await getFantasyCalcData(params);
  return { bySleeperId, byName };
}

/**
 * Applies a TE Premium adjustment to a value. TEP boosts TE values
 * since they score extra points per reception.
 */
export function applyTePremium(
  value: number,
  position: string,
  tePremiumBonus: number
): number {
  if (position !== "TE" || tePremiumBonus <= 0) return value;
  // Scale boost by bonus amount: 0.5 PPR bonus ~ +12% value, 1.0 ~ +20%
  const boost = 1 + Math.min(tePremiumBonus, 1) * 0.2;
  return Math.min(100, Math.round(value * boost));
}

/**
 * Builds a lookup of draft pick values from FantasyCalc data.
 * FantasyCalc names current-class picks as "<year> Pick <round>.<slot>" (e.g.
 * "2026 Pick 1.03") and future picks generically as "<year> 1st" / "2nd" / etc.
 * Returns helpers to value both kinds.
 */
export interface PickValueLookup {
  // named current-class picks keyed by `${year}-${round}-${slot}`
  named: Record<string, number>;
  // generic future picks keyed by `${year}-${round}`
  generic: Record<string, number>;
}

const ROUND_SUFFIX: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th" };

export async function getFantasyCalcPickValues(
  params: FetchValuesParams = {}
): Promise<PickValueLookup> {
  return (await getFantasyCalcData(params)).picks;
}

/**
 * Values a draft pick. For the current rookie class with a known slot, uses the
 * named pick value. For future picks, uses the generic round value, then nudges
 * by projected draft slot (early/mid/late) derived from the owning team's
 * contention (rebuilders pick earlier = more valuable).
 */
export function valuePick(
  lookup: PickValueLookup,
  year: number,
  round: number,
  opts: { slot?: number; projectedSlotPct?: number; teams?: number } = {}
): number {
  const { slot, projectedSlotPct, teams = 12 } = opts;

  if (slot != null) {
    const exact = lookup.named[`${year}-${round}-${slot}`];
    if (exact != null) return exact;
  }

  const generic = lookup.generic[`${year}-${round}`];
  if (generic != null) {
    // Adjust generic (mid) value by projected slot. projectedSlotPct 0=early,
    // 1=late. A 1st can swing ~+45% early to ~-35% late.
    if (projectedSlotPct != null) {
      const swing = round === 1 ? 0.45 : round === 2 ? 0.3 : 0.2;
      const factor = 1 + swing * (0.5 - projectedSlotPct) * 2;
      return Math.round(generic * factor);
    }
    return generic;
  }

  // Fallback: try to interpolate from a named pick at mid slot of that year.
  const midSlot = Math.ceil(teams / 2);
  const namedMid = lookup.named[`${year}-${round}-${midSlot}`];
  if (namedMid != null) return namedMid;

  // Last-resort baseline by round (0-100 scale).
  return round === 1 ? 30 : round === 2 ? 15 : round === 3 ? 11 : 8;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'']/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, "")
    .trim();
}
