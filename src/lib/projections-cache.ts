/**
 * Projections Cache
 * 
 * Client-side caching for Sleeper projections to avoid excessive API calls.
 * Caches projections in memory with TTL.
 */

import { getWeeklyProjections, getCurrentNFLWeek as _getCurrentNFLWeek, type PlayerProjection } from "./projections-api";

// Re-export for convenience
export { getCurrentNFLWeek } from "./projections-api";

interface CacheEntry {
  data: Record<string, PlayerProjection>;
  timestamp: number;
  season: number;
  week: number;
}

// In-memory cache
const cache = new Map<string, CacheEntry>();

// Cache TTL: 1 hour (projections don't change that often)
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Get cached projections or fetch fresh ones
 * 
 * @param season - NFL season year
 * @param week - NFL week
 * @param seasonType - Season type
 * @returns Player projections map
 */
export async function getCachedProjections(
  season?: number,
  week?: number,
  seasonType: "regular" | "post" | "pre" = "regular"
): Promise<Record<string, PlayerProjection>> {
  // Use current week if not specified
  if (!season || !week) {
    const current = _getCurrentNFLWeek();
    season = season || current.season;
    week = week || current.week;
  }
  
  const cacheKey = `${season}-${week}-${seasonType}`;
  const cached = cache.get(cacheKey);
  
  // Return cached data if still valid
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[Projections] Using cached data for ${season} week ${week}`);
    return cached.data;
  }
  
  // Fetch fresh data
  console.log(`[Projections] Fetching fresh data for ${season} week ${week}`);
  const data = await getWeeklyProjections(season, week, seasonType);
  
  // Cache it
  cache.set(cacheKey, {
    data,
    timestamp: Date.now(),
    season: season!,
    week: week!,
  });
  
  return data;
}

/**
 * Clear the cache (useful for testing or forcing refresh)
 */
export function clearProjectionsCache(): void {
  cache.clear();
  console.log("[Projections] Cache cleared");
}

/**
 * Get cache stats (for debugging)
 */
export function getCacheStats(): { size: number; entries: Array<{ key: string; age: number }> } {
  const entries = Array.from(cache.entries()).map(([key, entry]) => ({
    key,
    age: Date.now() - entry.timestamp,
  }));
  
  return {
    size: cache.size,
    entries,
  };
}
