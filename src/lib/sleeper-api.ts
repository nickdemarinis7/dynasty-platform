import type { SleeperLeague, SleeperRoster, SleeperUser } from "@/types";

const SLEEPER_BASE_URL = "https://api.sleeper.app/v1";

export async function getSleeperUser(username: string): Promise<SleeperUser> {
  const res = await fetch(`${SLEEPER_BASE_URL}/user/${username}`);
  if (!res.ok) throw new Error(`User "${username}" not found`);
  return res.json();
}

export async function getSleeperLeagues(
  userId: string,
  sport: string = "nfl",
  season: string = "2025"
): Promise<SleeperLeague[]> {
  const res = await fetch(
    `${SLEEPER_BASE_URL}/user/${userId}/leagues/${sport}/${season}`
  );
  if (!res.ok) throw new Error("Failed to fetch leagues");
  return res.json();
}

export async function getSleeperLeague(
  leagueId: string
): Promise<SleeperLeague> {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}`);
  if (!res.ok) throw new Error("Failed to fetch league");
  return res.json();
}

export async function getSleeperRosters(
  leagueId: string
): Promise<SleeperRoster[]> {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}/rosters`);
  if (!res.ok) throw new Error("Failed to fetch rosters");
  return res.json();
}

export async function getSleeperLeagueUsers(
  leagueId: string
): Promise<SleeperUser[]> {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}/users`);
  if (!res.ok) throw new Error("Failed to fetch league users");
  return res.json();
}

export async function getSleeperDrafts(leagueId: string) {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}/drafts`);
  if (!res.ok) throw new Error("Failed to fetch drafts");
  return res.json();
}

export interface SleeperDraft {
  draft_id: string;
  status: string;
  type: string;
  season: string;
  settings: {
    rounds: number;
    teams: number;
    reversal_round?: number;
    slots_qb?: number;
  };
  slot_to_roster_id: Record<string, number>;
  draft_order: Record<string, number> | null;
  last_picked?: number;
  start_time?: number;
}

export interface SleeperDraftPick {
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number;
  picked_by: string;
  player_id: string;
  is_keeper: boolean | null;
  metadata: {
    first_name: string;
    last_name: string;
    position: string;
    team: string;
  };
}

export async function getSleeperDraft(draftId: string): Promise<SleeperDraft> {
  const res = await fetch(`${SLEEPER_BASE_URL}/draft/${draftId}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch draft");
  return res.json();
}

export async function getSleeperDraftPicks(
  draftId: string
): Promise<SleeperDraftPick[]> {
  const res = await fetch(`${SLEEPER_BASE_URL}/draft/${draftId}/picks`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch draft picks");
  return res.json();
}

export async function getSleeperTradedPicks(leagueId: string) {
  const res = await fetch(
    `${SLEEPER_BASE_URL}/league/${leagueId}/traded_picks`
  );
  if (!res.ok) throw new Error("Failed to fetch traded picks");
  return res.json();
}

export interface SleeperTransaction {
  transaction_id: string;
  type: string; // "trade", "waiver", "free_agent", etc.
  status: "complete" | "pending" | "cancelled";
  metadata: {
    [key: string]: any;
  };
  roster_ids: number[];
  adds: {
    [playerId: string]: number; // player_id -> roster_id
  };
  drops: {
    [playerId: string]: number; // player_id -> roster_id
  };
  draft_picks: {
    [pickId: string]: number; // pick_id -> roster_id
  };
  waiver_budget: {
    [rosterId: string]: number;
  };
  created: number;
  updated: number;
}

export async function getSleeperTransactions(leagueId: string, week: number): Promise<SleeperTransaction[]> {
  // Fetch transactions for a specific week
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}/transactions/${week}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function getSleeperLeagueInfo(leagueId: string): Promise<{ season: string; previous_league_id: string | null }> {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}`);
  if (!res.ok) throw new Error("Failed to fetch league info");
  const data = await res.json();
  return {
    season: data.season,
    previous_league_id: data.previous_league_id || null,
  };
}

export async function getSleeperPlayers(): Promise<
  Record<string, { 
    player_id: string; 
    first_name: string; 
    last_name: string; 
    position: string; 
    team: string; 
    age: number; 
    years_exp: number | null; 
    fantasy_positions: string[];
    injury_status?: string;  // "Out", "Questionable", "Doubtful", "IR", "PUP", "Suspended", etc.
  }>
> {
  const res = await fetch(`${SLEEPER_BASE_URL}/players/nfl`);
  if (!res.ok) throw new Error("Failed to fetch players");
  return res.json();
}

export function mapSleeperPositions(positions: string[]): {
  superflex: boolean;
  tePremium: boolean;
  rosterSlots: { type: string; count: number }[];
} {
  const slotCounts: Record<string, number> = {};
  let superflex = false;

  for (const pos of positions) {
    const mapped = mapPositionSlot(pos);
    if (mapped === "SUPERFLEX") superflex = true;
    slotCounts[mapped] = (slotCounts[mapped] || 0) + 1;
  }

  const rosterSlots = Object.entries(slotCounts).map(([type, count]) => ({
    type,
    count,
  }));

  return { superflex, tePremium: false, rosterSlots };
}

function mapPositionSlot(sleeperPos: string): string {
  const map: Record<string, string> = {
    QB: "QB",
    RB: "RB",
    WR: "WR",
    TE: "TE",
    K: "K",
    DEF: "DEF",
    FLEX: "FLEX",
    SUPER_FLEX: "SUPERFLEX",
    REC_FLEX: "FLEX",
    WRRB_FLEX: "FLEX",
    BN: "BN",
    IR: "IR",
  };
  return map[sleeperPos] || sleeperPos;
}
