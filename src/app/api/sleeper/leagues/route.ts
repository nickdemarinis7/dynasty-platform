import { getSleeperUser, getSleeperLeagues } from "@/lib/sleeper-api";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const username = searchParams.get("username");

  if (!username) {
    return Response.json({ error: "Username is required" }, { status: 400 });
  }

  try {
    const user = await getSleeperUser(username);

    // Fetch leagues from multiple seasons to find all dynasty leagues
    const currentYear = new Date().getFullYear();
    const seasons = Array.from({ length: 10 }, (_, i) => String(currentYear + 1 - i));
    const allLeagues: any[] = [];
    const seenIds = new Set<string>();

    for (const season of seasons) {
      try {
        const leagues = await getSleeperLeagues(user.user_id, "nfl", season);
        for (const league of leagues) {
          if (!seenIds.has(league.league_id)) {
            seenIds.add(league.league_id);
            allLeagues.push({ ...league, season });
          }
        }
      } catch {
        // Season might not exist yet, skip
      }
    }

    // Return all leagues - let the user pick which one
    return Response.json({
      user,
      leagues: allLeagues,
    });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}
