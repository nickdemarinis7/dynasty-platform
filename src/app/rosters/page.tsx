"use client";

import { useAppStore } from "@/store";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DEFAULT_DYNASTY_VALUES } from "@/lib/player-values";
import { cn } from "@/lib/utils";
import { Crown, Users, Search, TrendingUp, ArrowRight } from "lucide-react";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";

export default function RostersPage() {
  const { rosters, myTeamId, personalValues } = useAppStore();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"value" | "name">("value");

  const getPlayerValue = (player: { id: string; name: string; dynastyValue: number }) => {
    if (personalValues[player.id]) return personalValues[player.id];
    return player.dynastyValue || DEFAULT_DYNASTY_VALUES[player.name] || 0;
  };

  const getRosterValue = (roster: typeof rosters[0]) => {
    return roster.players.reduce((sum, p) => sum + getPlayerValue(p), 0);
  };

  const getPositionCounts = (roster: typeof rosters[0]) => {
    const counts: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
    roster.players.forEach((p) => {
      if (counts[p.position] !== undefined) counts[p.position]++;
    });
    return counts;
  };

  const getAverageAge = (roster: typeof rosters[0]) => {
    const ages = roster.players.filter((p) => p.age > 0).map((p) => p.age);
    if (ages.length === 0) return 0;
    return ages.reduce((sum, age) => sum + age, 0) / ages.length;
  };

  // League-average-anchored scale: avg team scores ~65, elite ~85-90, rebuilds ~40-55.
  // 100 is achievable but requires being ~54% above league average — a meaningful ceiling.
  const leagueAvgValue = useMemo(() => {
    if (rosters.length === 0) return 1;
    const total = rosters.reduce((sum, r) => sum + getRosterValue(r), 0);
    return Math.max(total / rosters.length, 1);
  }, [rosters]);

  const sortedRosters = useMemo(() => {
    const filtered = rosters.filter(
      (r) =>
        r.teamName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.ownerName.toLowerCase().includes(searchQuery.toLowerCase())
    );
    return [...filtered].sort((a, b) => {
      if (sortBy === "value") return getRosterValue(b) - getRosterValue(a);
      return a.teamName.localeCompare(b.teamName);
    });
  }, [rosters, searchQuery, sortBy]);

  if (rosters.length === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight gradient-text">Rosters</h1>
          <p className="text-muted-foreground mt-2 text-lg">
            Connect your league first to view rosters
          </p>
        </div>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No rosters loaded yet.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight gradient-text">Rosters</h1>
          <p className="text-muted-foreground mt-2 text-lg">
            View all teams and their dynasty values
          </p>
        </div>
      </div>

      {/* Search and Filter Bar */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search teams or owners..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant={sortBy === "value" ? "secondary" : "outline"}
                size="sm"
                onClick={() => setSortBy("value")}
              >
                <TrendingUp className="h-4 w-4 mr-2" />
                By Value
              </Button>
              <Button
                variant={sortBy === "name" ? "secondary" : "outline"}
                size="sm"
                onClick={() => setSortBy("name")}
              >
                By Name
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Team List */}
      <Card>
        <CardContent className="p-0">
          {/* Column headers */}
          <div className="flex items-center gap-4 px-6 py-2.5 border-b border-border">
            <span className="w-7 shrink-0" />
            <span className="flex-1 text-xs text-muted-foreground uppercase tracking-wide">Team</span>
            <span className="w-44 text-xs text-muted-foreground uppercase tracking-wide">Roster Depth</span>
            <span className="w-20 text-center text-xs text-muted-foreground uppercase tracking-wide">Avg Age</span>
            <span className="w-16 text-right text-xs text-muted-foreground uppercase tracking-wide">Rating</span>
            <span className="w-8 shrink-0" />
          </div>
          <div className="divide-y divide-border">
            {sortedRosters.map((roster, idx) => {
              const rosterValue = getRosterValue(roster);
              const rating = Math.min(99, Math.round((rosterValue / leagueAvgValue) * 65));
              const posCounts = getPositionCounts(roster);
              const avgAge = getAverageAge(roster);
              const isMyTeam = roster.teamId === myTeamId;

              const rankColor =
                idx === 0 ? "text-yellow-400 font-black" :
                idx === 1 ? "text-slate-300 font-black" :
                idx === 2 ? "text-orange-400 font-black" :
                "text-muted-foreground font-semibold";

              const ratingColor =
                rating >= 88 ? "text-green-400" :
                rating >= 74 ? "text-emerald-400" :
                rating >= 60 ? "text-yellow-400" :
                rating >= 46 ? "text-orange-400" :
                "text-red-400";

              return (
                <div
                  key={roster.teamId}
                  className={cn(
                    "flex items-center gap-4 px-6 py-3.5 hover:bg-muted/40 cursor-pointer transition-colors",
                    isMyTeam && "bg-primary/5 border-l-2 border-l-primary"
                  )}
                  onClick={() => router.push(`/rosters/${roster.teamId}`)}
                >
                  {/* Rank */}
                  <span className={cn("text-sm w-7 shrink-0", rankColor)}>
                    {idx + 1}
                  </span>

                  {/* Team identity */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold truncate">{roster.teamName}</span>
                      {isMyTeam && <Crown className="h-3.5 w-3.5 text-yellow-500 shrink-0" />}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{roster.ownerName}</p>
                  </div>

                  {/* Position pills */}
                  <div className="flex items-center gap-1.5 w-44">
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-500/15 text-blue-400">QB {posCounts.QB}</span>
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-500/15 text-green-400">RB {posCounts.RB}</span>
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-yellow-500/15 text-yellow-400">WR {posCounts.WR}</span>
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-orange-500/15 text-orange-400">TE {posCounts.TE}</span>
                  </div>

                  {/* Avg Age */}
                  <div className="w-20 text-center">
                    <span className="text-sm font-medium">{avgAge > 0 ? avgAge.toFixed(1) : "—"}</span>
                  </div>

                  {/* Rating */}
                  <div className={cn("w-16 text-right tabular-nums font-black text-2xl leading-none", ratingColor)}>
                    {rating}
                  </div>

                  {/* Arrow */}
                  <div className="w-8 flex justify-end">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
