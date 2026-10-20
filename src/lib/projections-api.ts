/**
 * Sleeper Projections API
 * 
 * Fetches weekly player projections from Sleeper's undocumented projections endpoint.
 * These are pre-game predictions for all NFL players.
 */

const SLEEPER_BASE_URL = "https://api.sleeper.com";

export interface PlayerProjection {
  player_id: string;
  week: number;
  season: string;
  season_type: "regular" | "post" | "pre";
  status: string | null;
  date: string;
  category: string;
  
  // Stats are nested in a 'stats' object
  stats: {
    // Scoring projections
    pts_ppr?: number;
    pts_half_ppr?: number;
    pts_std?: number;
    
    // Passing stats
    pass_yd?: number;
    pass_td?: number;
    pass_int?: number;
    pass_att?: number;
    pass_cmp?: number;
    pass_2pt?: number;
    
    // Rushing stats
    rush_yd?: number;
    rush_td?: number;
    rush_att?: number;
    rush_2pt?: number;
    
    // Receiving stats
    rec?: number;
    rec_yd?: number;
    rec_td?: number;
    rec_2pt?: number;
    rec_tgt?: number;
    
    // Other stats
    fum_lost?: number;
    fum?: number;
    
    // Kicker stats
    fgm?: number;
    fga?: number;
    xpm?: number;
    xpa?: number;
    
    // Defense stats (for DEF positions)
    def_td?: number;
    def_int?: number;
    def_sack?: number;
    def_safety?: number;
    def_ff?: number;
    def_fr?: number;
    pts_allow?: number;
    yds_allow?: number;
  };
}

/**
 * Fetch weekly projections for all players
 * 
 * @param season - NFL season year (e.g., 2024, 2025)
 * @param week - NFL week (1-18)
 * @param seasonType - Season type: "regular", "post", "pre"
 * @returns Map of player_id to projection data
 */
export async function getWeeklyProjections(
  season: number | string,
  week: number,
  seasonType: "regular" | "post" | "pre" = "regular"
): Promise<Record<string, PlayerProjection>> {
  try {
    const url = `${SLEEPER_BASE_URL}/projections/nfl/${season}/${week}?season_type=${seasonType}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Failed to fetch projections for ${season} week ${week}: ${res.status}`);
    }
    
    const data: unknown = await res.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Sleeper returned invalid weekly projections");
    }
    return data as Record<string, PlayerProjection>;
  } catch (error) {
    console.error(`Error fetching projections:`, error);
    throw error;
  }
}

/**
 * Fetch season-long projections for a specific player
 * 
 * @param playerId - Sleeper player ID
 * @param season - NFL season year
 * @param seasonType - Season type: "regular", "post", "pre"
 * @returns Map of week number to projection data
 */
export async function getPlayerSeasonProjections(
  playerId: string,
  season: number | string,
  seasonType: "regular" | "post" | "pre" = "regular"
): Promise<Record<number, PlayerProjection>> {
  try {
    const url = `${SLEEPER_BASE_URL}/projections/nfl/player/${playerId}?season=${season}&season_type=${seasonType}&grouping=week`;
    const res = await fetch(url);
    
    if (!res.ok) {
      console.warn(`Failed to fetch player projections for ${playerId}: ${res.status}`);
      return {};
    }
    
    const data: unknown = await res.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Sleeper returned invalid player projections");
    }
    return data as Record<number, PlayerProjection>;
  } catch (error) {
    console.error(`Error fetching player projections:`, error);
    return {};
  }
}

/**
 * Calculate rest-of-season projection for a player
 * 
 * @param playerId - Sleeper player ID
 * @param season - NFL season year
 * @param currentWeek - Current NFL week
 * @param scoringType - Scoring format: "ppr", "half_ppr", "std"
 * @param playoffWeightMultiplier - Multiplier for playoff weeks (15-17), default 1.2
 * @returns Total projected points for rest of season
 */
export async function getRestOfSeasonProjection(
  playerId: string,
  season: number | string,
  currentWeek: number,
  scoringType: "ppr" | "half_ppr" | "std" = "half_ppr",
  playoffWeightMultiplier: number = 1.2
): Promise<number> {
  const seasonProjections = await getPlayerSeasonProjections(playerId, season);
  
  let totalPoints = 0;
  const pointsField = scoringType === "ppr" ? "pts_ppr" : 
                      scoringType === "half_ppr" ? "pts_half_ppr" : 
                      "pts_std";
  
  // Sum up projections from current week through week 18
  for (let week = currentWeek; week <= 18; week++) {
    const projection = seasonProjections[week];
    if (projection && projection.stats && projection.stats[pointsField] !== undefined) {
      let points = projection.stats[pointsField]!;
      
      // Apply playoff weight for weeks 15-17
      if (week >= 15 && week <= 17) {
        points *= playoffWeightMultiplier;
      }
      
      totalPoints += points;
    }
  }
  
  return totalPoints;
}

/**
 * Get current NFL season and week
 * This is a simple approximation - in production you'd want to fetch this from an API
 */
export function getCurrentNFLWeek(): { season: number; week: number; isPlayoffs: boolean } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-11
  
  // NFL season runs September (month 8) through February (month 1)
  let season = year;
  if (month < 2) {
    // January-February = previous year's season
    season = year - 1;
  } else if (month >= 8) {
    // September-December = current year's season
    season = year;
  } else {
    // March-August = off-season, use upcoming season
    season = year;
  }
  
  // Rough week estimation (NFL starts early September)
  // Week 1 typically starts around September 7-10
  const seasonStart = new Date(season, 8, 7); // September 7
  const daysSinceStart = Math.floor((now.getTime() - seasonStart.getTime()) / (1000 * 60 * 60 * 24));
  const week = Math.max(1, Math.min(18, Math.floor(daysSinceStart / 7) + 1));
  
  const isPlayoffs = week >= 15 && week <= 18;
  
  return { season, week, isPlayoffs };
}

/**
 * Batch fetch projections for multiple players
 * More efficient than individual calls
 */
export async function getBatchProjections(
  playerIds: string[],
  season: number | string,
  week: number,
  seasonType: "regular" | "post" | "pre" = "regular"
): Promise<Record<string, PlayerProjection>> {
  // Fetch all projections for the week
  const allProjections = await getWeeklyProjections(season, week, seasonType);
  
  // Filter to only requested players
  const result: Record<string, PlayerProjection> = {};
  for (const playerId of playerIds) {
    if (allProjections[playerId]) {
      result[playerId] = allProjections[playerId];
    }
  }
  
  return result;
}
