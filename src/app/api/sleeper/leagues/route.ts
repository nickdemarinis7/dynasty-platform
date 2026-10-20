import { getSleeperUser, getSleeperLeagues } from "@/lib/sleeper-api";
import { NextRequest } from "next/server";
import type { SleeperLeague } from "@/types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load leagues";
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const username = searchParams.get("username");

  if (!username) {
    return Response.json({ error: "Username is required" }, { status: 400 });
  }

  try {
    const user = await getSleeperUser(username);

    // Search recent seasons in bounded parallel batches. Sequential requests
    // made account connection unnecessarily slow, while one large burst risks
    // upstream throttling.
    const currentYear = new Date().getFullYear();
    const seasons = Array.from({ length: 10 }, (_, i) => String(currentYear + 1 - i));
    const allLeagues: Array<SleeperLeague & { season: string }> = [];
    const seenIds = new Set<string>();

    for (let index = 0; index < seasons.length; index += 4) {
      const batch = seasons.slice(index, index + 4);
      const results = await Promise.all(batch.map(async (season) => {
        try {
          return { season, leagues: await getSleeperLeagues(user.user_id, "nfl", season) };
        } catch {
          return { season, leagues: [] as SleeperLeague[] };
        }
      }));

      for (const { season, leagues } of results) {
        for (const league of leagues) {
          if (!seenIds.has(league.league_id)) {
            seenIds.add(league.league_id);
            allLeagues.push({ ...league, season });
          }
        }
      }
    }

    // Return all leagues - let the user pick which one
    return Response.json({
      user,
      leagues: allLeagues,
    });
  } catch (error: unknown) {
    return Response.json({ error: errorMessage(error) }, { status: 400 });
  }
}
