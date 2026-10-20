import { getSleeperNFLState } from "@/lib/sleeper-api";

export async function GET() {
  try {
    const state = await getSleeperNFLState();
    return Response.json({
      season: Number(state.season),
      week: state.week,
      seasonType: state.season_type,
      isPlayoffs: state.season_type === "post" || state.week >= 15,
      source: "sleeper",
    });
  } catch {
    return Response.json({ error: "NFL state is temporarily unavailable" }, { status: 502 });
  }
}
