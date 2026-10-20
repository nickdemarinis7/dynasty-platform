import type { LeagueMode, SleeperLeague, SleeperRoster, SleeperUser } from "@/types";

const SLEEPER_BASE_URL = "https://api.sleeper.app/v1";

export function expectSleeperObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Sleeper returned invalid ${label} data`);
  }
  return value as Record<string, unknown>;
}

export function expectSleeperArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Sleeper returned invalid ${label} data`);
  return value;
}

export interface SleeperNFLState {
  season: string;
  week: number;
  season_type: "pre" | "regular" | "post";
}

export function parseSleeperNFLState(payload: unknown): SleeperNFLState {
  const state = expectSleeperObject(payload, "NFL state");
  if (typeof state.season !== "string" || !/^\d{4}$/.test(state.season)) {
    throw new Error("Sleeper NFL state is missing a valid season");
  }
  if (typeof state.week !== "number" || !Number.isFinite(state.week)) {
    throw new Error("Sleeper NFL state is missing a valid week");
  }
  const seasonType = state.season_type;
  return {
    season: state.season,
    week: Math.max(1, Math.min(18, Math.trunc(state.week))),
    season_type: seasonType === "pre" || seasonType === "post" ? seasonType : "regular",
  };
}

export function parseSleeperUser(payload: unknown): SleeperUser {
  const data = expectSleeperObject(payload, "user");
  if (typeof data.user_id !== "string" || typeof data.username !== "string") {
    throw new Error("Sleeper user data is missing required fields");
  }
  return data as unknown as SleeperUser;
}

export function parseSleeperLeague(payload: unknown): SleeperLeague {
  const data = expectSleeperObject(payload, "league");
  if (typeof data.league_id !== "string" || typeof data.name !== "string") {
    throw new Error("Sleeper league data is missing required fields");
  }
  if (!Array.isArray(data.roster_positions)) {
    throw new Error("Sleeper league data is missing roster positions");
  }
  if (typeof data.total_rosters !== "number" || !Number.isFinite(data.total_rosters)) {
    throw new Error("Sleeper league data is missing its team count");
  }
  return data as unknown as SleeperLeague;
}

export function parseSleeperLeagueList(payload: unknown): SleeperLeague[] {
  return expectSleeperArray(payload, "league list").map((league) => parseSleeperLeague(league));
}

export function getSleeperLeagueMode(league: SleeperLeague): LeagueMode {
  if (league.settings?.type === 2) return "dynasty";
  if (league.settings?.type === 1) return "keeper";
  return "redraft";
}

export function parseSleeperRosters(payload: unknown): SleeperRoster[] {
  return expectSleeperArray(payload, "rosters").map((value) => {
    const roster = expectSleeperObject(value, "roster");
    if (typeof roster.roster_id !== "number" || !Number.isFinite(roster.roster_id)) {
      throw new Error("Sleeper roster is missing its roster ID");
    }
    if (roster.owner_id !== null && typeof roster.owner_id !== "string") {
      throw new Error("Sleeper roster has an invalid owner ID");
    }
    const players = roster.players ?? [];
    const starters = roster.starters ?? [];
    if (!Array.isArray(players) || !players.every((id) => typeof id === "string")) {
      throw new Error("Sleeper roster has an invalid player list");
    }
    if (!Array.isArray(starters) || !starters.every((id) => typeof id === "string")) {
      throw new Error("Sleeper roster has an invalid starter list");
    }
    return { ...roster, owner_id: roster.owner_id ?? null, players, starters } as unknown as SleeperRoster;
  });
}

export function findSleeperRosterForUser(
  rosters: SleeperRoster[],
  userId: string,
): SleeperRoster | undefined {
  return rosters.find((roster) => roster.owner_id === userId);
}

export function parseSleeperLeagueUsers(payload: unknown): SleeperUser[] {
  return expectSleeperArray(payload, "league users")
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    .filter((user) => typeof user.user_id === "string")
    .map((user) => ({
      ...user,
      username: typeof user.username === "string" ? user.username : "Unknown",
      display_name: typeof user.display_name === "string" ? user.display_name : "Unknown Manager",
      avatar: typeof user.avatar === "string" ? user.avatar : "",
    })) as unknown as SleeperUser[];
}

export async function getSleeperNFLState(): Promise<SleeperNFLState> {
  const res = await fetch(`${SLEEPER_BASE_URL}/state/nfl`, { next: { revalidate: 300 } });
  if (!res.ok) throw new Error("Failed to fetch NFL state");
  return parseSleeperNFLState(await res.json());
}

export function getCurrentNFLSeason(date: Date = new Date()): string {
  const year = date.getFullYear();
  return String(date.getMonth() < 2 ? year - 1 : year);
}

export async function getSleeperUser(username: string): Promise<SleeperUser> {
  const res = await fetch(`${SLEEPER_BASE_URL}/user/${username}`);
  if (!res.ok) throw new Error(`User "${username}" not found`);
  return parseSleeperUser(await res.json());
}

export async function getSleeperLeagues(
  userId: string,
  sport: string = "nfl",
  season: string = getCurrentNFLSeason()
): Promise<SleeperLeague[]> {
  const res = await fetch(
    `${SLEEPER_BASE_URL}/user/${userId}/leagues/${sport}/${season}`
  );
  if (!res.ok) throw new Error("Failed to fetch leagues");
  return parseSleeperLeagueList(await res.json());
}

export async function getSleeperLeague(
  leagueId: string
): Promise<SleeperLeague> {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}`);
  if (!res.ok) throw new Error("Failed to fetch league");
  return parseSleeperLeague(await res.json());
}

export async function getSleeperRosters(
  leagueId: string
): Promise<SleeperRoster[]> {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}/rosters`);
  if (!res.ok) throw new Error("Failed to fetch rosters");
  return parseSleeperRosters(await res.json());
}

export async function getSleeperLeagueUsers(
  leagueId: string
): Promise<SleeperUser[]> {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}/users`);
  if (!res.ok) throw new Error("Failed to fetch league users");
  return parseSleeperLeagueUsers(await res.json());
}

export async function getSleeperDrafts(leagueId: string): Promise<SleeperDraft[]> {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}/drafts`);
  if (!res.ok) throw new Error("Failed to fetch drafts");
  return expectSleeperArray(await res.json(), "drafts") as SleeperDraft[];
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
  return expectSleeperObject(await res.json(), "draft") as unknown as SleeperDraft;
}

export async function getSleeperDraftPicks(
  draftId: string
): Promise<SleeperDraftPick[]> {
  const res = await fetch(`${SLEEPER_BASE_URL}/draft/${draftId}/picks`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch draft picks");
  return expectSleeperArray(await res.json(), "draft picks") as SleeperDraftPick[];
}

export interface SleeperTradedPick {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id: number;
  owner_id: number;
}

export async function getSleeperTradedPicks(leagueId: string): Promise<SleeperTradedPick[]> {
  const res = await fetch(
    `${SLEEPER_BASE_URL}/league/${leagueId}/traded_picks`
  );
  if (!res.ok) throw new Error("Failed to fetch traded picks");
  return expectSleeperArray(await res.json(), "traded picks") as SleeperTradedPick[];
}

export interface SleeperTransaction {
  transaction_id: string;
  type: string; // "trade", "waiver", "free_agent", etc.
  status: "complete" | "pending" | "cancelled";
  metadata: {
    [key: string]: unknown;
  };
  roster_ids: number[];
  adds: {
    [playerId: string]: number; // player_id -> roster_id
  };
  drops: {
    [playerId: string]: number; // player_id -> roster_id
  };
  draft_picks: Array<{
    season: string;
    round: number;
    roster_id: number;
    previous_owner_id: number;
    owner_id: number;
  }>;
  waiver_budget: {
    [rosterId: string]: number;
  };
  created: number;
  updated: number;
}

export async function getSleeperTransactions(leagueId: string, week: number): Promise<SleeperTransaction[]> {
  // Fetch transactions for a specific week
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}/transactions/${week}`, {
    next: { revalidate: 3600 },
  });
  if (!res.ok) return [];
  return expectSleeperArray(await res.json(), "transactions") as SleeperTransaction[];
}

export async function getSleeperLeagueInfo(leagueId: string): Promise<{ season: string; previous_league_id: string | null }> {
  const res = await fetch(`${SLEEPER_BASE_URL}/league/${leagueId}`);
  if (!res.ok) throw new Error("Failed to fetch league info");
  const data = expectSleeperObject(await res.json(), "league info");
  if (typeof data.season !== "string") throw new Error("Sleeper league info is missing its season");
  return {
    season: data.season,
    previous_league_id: typeof data.previous_league_id === "string" ? data.previous_league_id : null,
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
  return expectSleeperObject(await res.json(), "players") as unknown as Awaited<ReturnType<typeof getSleeperPlayers>>;
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
