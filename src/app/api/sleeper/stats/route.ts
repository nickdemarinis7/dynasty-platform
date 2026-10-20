import { NextResponse } from "next/server";
import type { PlayerSeasonStats } from "@/types";
import { getCurrentNFLSeason } from "@/lib/sleeper-api";

const STAT_FIELDS: (keyof PlayerSeasonStats)[] = [
  "pts_half_ppr", "pts_ppr", "tgt", "rec", "rec_yd", "rec_td",
  "rec_air_yd", "rec_yac", "rush_att", "rush_yd", "rush_td",
  "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int",
  "off_snp", "tm_off_snp", "rz_tgt", "rz_rush_att",
];

function emptyStats(): PlayerSeasonStats {
  return {
    gp: 0, pts_half_ppr: 0, pts_ppr: 0, tgt: 0, rec: 0,
    rec_yd: 0, rec_td: 0, rec_air_yd: 0, rec_yac: 0,
    rush_att: 0, rush_yd: 0, rush_td: 0, pass_att: 0, pass_cmp: 0,
    pass_yd: 0, pass_td: 0, pass_int: 0, off_snp: 0, tm_off_snp: 0,
    rz_tgt: 0, rz_rush_att: 0,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const season = searchParams.get("season") ?? getCurrentNFLSeason();
  const seasonNumber = Number(season);
  const maxSeason = Number(getCurrentNFLSeason()) + 1;
  if (!/^20\d{2}$/.test(season) || seasonNumber < 2000 || seasonNumber > maxSeason) {
    return NextResponse.json({ error: "Invalid season" }, { status: 400 });
  }
  const weeks = 18; // regular season

  // Fetch all weeks in parallel
  const weekPromises = Array.from({ length: weeks }, (_, i) =>
    fetch(`https://api.sleeper.app/v1/stats/nfl/regular/${season}/${i + 1}`, {
      next: { revalidate: 86400 }, // cache 24h — season stats don't change
    }).then((r) => (r.ok ? r.json() : {}))
  );

  let weeklyData: Record<string, Record<string, number>>[];
  try {
    weeklyData = await Promise.all(weekPromises);
  } catch {
    return NextResponse.json({ error: "Failed to fetch Sleeper stats" }, { status: 502 });
  }

  // Aggregate per player
  const aggregated: Record<string, PlayerSeasonStats> = {};

  for (const weekStats of weeklyData) {
    if (!weekStats || typeof weekStats !== "object") continue;

    for (const [playerId, raw] of Object.entries(weekStats)) {
      if (!raw || typeof raw !== "object") continue;

      // Count as a game played if they had any offensive snap
      const snaps = (raw as Record<string, number>).off_snp ?? 0;
      const pts = (raw as Record<string, number>).pts_half_ppr ?? 0;
      if (snaps === 0 && pts === 0) continue; // didn't play

      if (!aggregated[playerId]) aggregated[playerId] = emptyStats();
      aggregated[playerId].gp += 1;

      for (const field of STAT_FIELDS) {
        const val = (raw as Record<string, number>)[field] ?? 0;
        (aggregated[playerId][field] as number) += val;
      }
    }
  }

  return NextResponse.json(aggregated);
}
