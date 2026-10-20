"use client";

import { useMemo, useState, useEffect } from "react";
import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_DYNASTY_VALUES } from "@/lib/player-values";
import { buildLeagueContext, optimizeLineup } from "@/lib/analytics";
import { getAuthoritativeNFLWeek, getCachedProjections } from "@/lib/projections-cache";
import type { PlayerProjection } from "@/lib/projections-api";
import type { Player } from "@/types";
import { Crown, Trophy, TrendingUp, BarChart3, Activity, Zap, Target } from "lucide-react";
import { cn } from "@/lib/utils";

const posBarColors: Record<string, string> = {
  QB: "bg-red-500",
  RB: "bg-green-500",
  WR: "bg-blue-500",
  TE: "bg-orange-500",
  Picks: "bg-violet-500",
};

type SortField = "overall" | "starters" | "depth" | "projection" | "age";

export default function RankingsPage() {
  const { rosters, myTeamId, leagueSettings } = useAppStore();
  const [sortBy, setSortBy] = useState<SortField>("overall");
  const [projections, setProjections] = useState<Record<string, PlayerProjection>>({});
  const [currentWeek, setCurrentWeek] = useState<{ season: number; week: number } | null>(null);

  // Fetch projections on mount
  useEffect(() => {
    async function fetchProjections() {
      try {
        const nflWeek = await getAuthoritativeNFLWeek();
        setCurrentWeek(nflWeek);
        const projs = await getCachedProjections(nflWeek.season, nflWeek.week, nflWeek.seasonType);
        setProjections(projs);
      } catch (error) {
        console.error("Failed to fetch projections:", error);
      }
    }
    fetchProjections();
  }, []);

  const getPlayerValue = (player: Player) => {
    return player.dynastyValue || DEFAULT_DYNASTY_VALUES[player.name] || 0;
  };

  const leagueCtx = useMemo(() => {
    if (!rosters.length || !leagueSettings) return null;
    return buildLeagueContext(rosters, leagueSettings, {});
  }, [rosters, leagueSettings]);

  const teamRankings = useMemo(() => {
    if (rosters.length === 0 || !leagueSettings) return [];

    const scoringType = leagueSettings.scoringType === "ppr" ? "ppr" : 
                        leagueSettings.scoringType === "half_ppr" ? "half_ppr" : "std";

    return rosters
      .map((roster) => {
        const posTotals: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
        let total = 0;
        let totalAge = 0;
        let playerCount = 0;

        for (const p of roster.players) {
          const val = getPlayerValue(p);
          total += val;
          if (posTotals[p.position] !== undefined) {
            posTotals[p.position] += val;
          }
          if (p.age > 0) {
            totalAge += p.age;
            playerCount++;
          }
        }

        const avgAge = playerCount > 0 ? totalAge / playerCount : 0;

        // Top 3 players
        const topPlayers = [...roster.players]
          .sort((a, b) => getPlayerValue(b) - getPlayerValue(a))
          .slice(0, 3);

        // Optimize lineup for weekly projection
        const optimized = optimizeLineup(
          roster.players,
          leagueSettings,
          false, // isPlayoffs
          currentWeek?.week || 1,
          projections,
          scoringType
        );

        // Calculate starter value using optimized lineup
        const starterValue = optimized.starters.reduce((sum, p) => sum + getPlayerValue(p), 0);
        const depthValue = total - starterValue;

        const picksValue = roster.draftPicks.reduce((sum, p) => sum + (p.estimatedValue ?? 0), 0);
        const grandTotal = total + picksValue;
        
        const ctx = leagueCtx?.get(roster.teamId);
        
        return {
          roster,
          total,
          grandTotal,
          posTotals,
          picksValue,
          topPlayers,
          starterValue,
          depthValue,
          weeklyProjection: optimized.totalProjectedPoints,
          avgAge,
          starterCount: optimized.starters.length,
          dynastyPowerScore: ctx?.dynastyPowerScore ?? 0,
          pickSurplusLabel: ctx?.pickSurplusLabel ?? "normal",
          windowLabel: ctx?.windowLabel ?? "",
          windowColor: ctx?.windowColor ?? "",
        };
      })
      .sort((a, b) => {
        switch (sortBy) {
          case "starters":
            return b.starterValue - a.starterValue;
          case "depth":
            return b.depthValue - a.depthValue;
          case "projection":
            return b.weeklyProjection - a.weeklyProjection;
          case "age":
            return a.avgAge - b.avgAge;
          default:
            return b.total - a.total;
        }
      });
  }, [rosters, leagueSettings, leagueCtx, projections, currentWeek, sortBy]);

  const { leagueAvgValue, leagueAvgStarters, leagueAvgDepth } = useMemo(() => {
    if (teamRankings.length === 0) return { 
      leagueAvgValue: 1, 
      leagueAvgStarters: 1, 
      leagueAvgDepth: 1,
    };
    const n = teamRankings.length;
    return {
      leagueAvgValue: Math.max(teamRankings.reduce((s, t) => s + t.total, 0) / n, 1),
      leagueAvgStarters: Math.max(teamRankings.reduce((s, t) => s + t.starterValue, 0) / n, 1),
      leagueAvgDepth: Math.max(teamRankings.reduce((s, t) => s + t.depthValue, 0) / n, 1),
    };
  }, [teamRankings]);

  const getRating = (v: number) => Math.min(99, Math.round((v / leagueAvgValue) * 65));
  const getStRating = (v: number) => Math.min(99, Math.round((v / leagueAvgStarters) * 65));
  const getDpRating = (v: number) => Math.min(99, Math.round((v / leagueAvgDepth) * 65));
  const getRatingColor = (r: number) => {
    if (r >= 88) return "text-green-400";
    if (r >= 74) return "text-emerald-400";
    if (r >= 60) return "text-yellow-400";
    if (r >= 46) return "text-orange-400";
    return "text-red-400";
  };

  if (rosters.length === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight gradient-text">Power Rankings</h1>
          <p className="text-muted-foreground mt-2 text-lg">Connect your league to see rankings</p>
        </div>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <BarChart3 className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No league data loaded yet.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const myTeamRank = teamRankings.findIndex(t => t.roster.teamId === myTeamId) + 1;
  const myTeam = teamRankings.find(t => t.roster.teamId === myTeamId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight gradient-text">Power Rankings</h1>
        <p className="text-muted-foreground mt-2 text-base sm:text-lg">
          {leagueSettings?.mode === "redraft" ? "Redraft" : "Dynasty"} rankings based on roster value and weekly projections
        </p>
        {myTeam && (
          <div className="mt-4 flex items-center gap-4 text-sm">
            <Badge variant="outline" className="text-yellow-500 border-yellow-500/30">
              <Crown className="h-3 w-3 mr-1" />
              Your Team: #{myTeamRank}
            </Badge>
            <span className="text-muted-foreground">
              {myTeam.windowLabel}
            </span>
          </div>
        )}
      </div>

      {/* Top 3 Podium */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {teamRankings.slice(0, 3).map((team, idx) => {
          const rating = getRating(team.total);
          return (
            <Card
              key={team.roster.teamId}
              className={cn(
                "relative overflow-hidden",
                idx === 0 && "border-yellow-500/50 shadow-yellow-500/20 shadow-lg",
                idx === 1 && "border-gray-400/50",
                idx === 2 && "border-amber-700/50",
                team.roster.teamId === myTeamId && "ring-2 ring-primary"
              )}
            >
              <CardContent className="py-6">
                <div className="flex flex-col items-center text-center">
                  <div
                    className={cn(
                      "flex items-center justify-center w-16 h-16 rounded-full text-2xl font-black mb-3",
                      idx === 0 && "bg-yellow-500/20 text-yellow-400",
                      idx === 1 && "bg-gray-400/20 text-gray-300",
                      idx === 2 && "bg-amber-700/20 text-amber-600"
                    )}
                  >
                    {idx === 0 ? <Trophy className="h-8 w-8" /> : idx + 1}
                  </div>
                  <p className="font-bold text-lg mb-1 flex items-center gap-1">
                    {team.roster.teamName}
                    {team.roster.teamId === myTeamId && (
                      <Crown className="h-4 w-4 text-yellow-500" />
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mb-3">{team.roster.ownerName}</p>
                  
                  <div className="flex items-center justify-center gap-4 mb-3">
                    <div className="text-center">
                      <p className={`text-2xl sm:text-3xl font-black tabular-nums ${getRatingColor(rating)}`}>
                        {rating}
                      </p>
                      <p className="text-[10px] text-muted-foreground">Overall</p>
                    </div>
                    {currentWeek && team.weeklyProjection > 0 && (
                      <div className="text-center">
                        <p className="text-xl font-bold text-green-500 tabular-nums">
                          {team.weeklyProjection.toFixed(1)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">Week {currentWeek.week}</p>
                      </div>
                    )}
                  </div>

                  <Badge variant="outline" className={cn("text-xs", team.windowColor)}>
                    {team.windowLabel}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Sort Controls */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs sm:text-sm text-muted-foreground mr-2">Sort by:</span>
            {[
              { value: "overall" as const, label: "Overall Value", icon: BarChart3 },
              { value: "starters" as const, label: "Starters", icon: Target },
              { value: "depth" as const, label: "Depth", icon: TrendingUp },
              { value: "projection" as const, label: "Week Projection", icon: Activity },
              { value: "age" as const, label: "Age (Youngest)", icon: Zap },
            ].map((option) => (
              <button
                key={option.value}
                onClick={() => setSortBy(option.value)}
                className={cn(
                  "px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors flex items-center gap-1 sm:gap-1.5",
                  sortBy === option.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-muted/80"
                )}
              >
                <option.icon className="h-3.5 w-3.5" />
                {option.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Full Rankings Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            Full Rankings
            {currentWeek && (
              <Badge variant="outline" className="text-xs">
                <Activity className="h-3 w-3 mr-1" />
                Week {currentWeek.week} Projections
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border/50 md:hidden">
            {teamRankings.map((team, idx) => {
              const overallRating = getRating(team.total);
              return (
                <div key={team.roster.teamId} className={cn("space-y-3 px-4 py-4", team.roster.teamId === myTeamId && "bg-primary/5")}>
                  <div className="flex items-start gap-3">
                    <span className={cn("pt-0.5 text-sm font-bold", idx === 0 ? "text-yellow-400" : "text-muted-foreground")}>#{idx + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                        {team.roster.teamName}
                        {team.roster.teamId === myTeamId && <Crown className="h-3.5 w-3.5 shrink-0 text-yellow-500" />}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{team.roster.ownerName}</p>
                    </div>
                    <Badge variant="outline" className={cn("shrink-0 text-[10px]", team.windowColor)}>{team.windowLabel}</Badge>
                  </div>
                  <div className="grid grid-cols-4 gap-2 rounded-lg bg-muted/30 p-2 text-center">
                    <div><p className="text-[10px] uppercase text-muted-foreground">Overall</p><p className={cn("text-sm font-black", getRatingColor(overallRating))}>{overallRating}</p></div>
                    <div><p className="text-[10px] uppercase text-muted-foreground">Starters</p><p className="text-sm font-bold">{getStRating(team.starterValue)}</p></div>
                    <div><p className="text-[10px] uppercase text-muted-foreground">Depth</p><p className="text-sm font-bold">{getDpRating(team.depthValue)}</p></div>
                    <div><p className="text-[10px] uppercase text-muted-foreground">{currentWeek ? `W${currentWeek.week}` : "Avg age"}</p><p className="text-sm font-bold">{currentWeek ? (team.weeklyProjection > 0 ? team.weeklyProjection.toFixed(1) : "—") : (team.avgAge > 0 ? team.avgAge.toFixed(1) : "—")}</p></div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="hidden overflow-x-auto md:block">
          <div className="px-4 sm:px-6 py-3 border-b border-border grid grid-cols-12 gap-2 sm:gap-4 text-xs text-muted-foreground font-medium min-w-[700px]">
            <div className="col-span-1">#</div>
            <div className="col-span-3">Team</div>
            <div className="col-span-1 text-right">Overall</div>
            <div className="col-span-1 text-right">Starters</div>
            <div className="col-span-1 text-right">Depth</div>
            {currentWeek && <div className="col-span-1 text-right">Week {currentWeek.week}</div>}
            <div className={cn("text-right", currentWeek ? "col-span-1" : "col-span-2")}>Avg Age</div>
            <div className={cn(currentWeek ? "col-span-3" : "col-span-4")}>Composition</div>
          </div>

          {teamRankings.map((team, idx) => {
            const overallRating = getRating(team.total);
            const starterRating = getStRating(team.starterValue);
            const depthRating = getDpRating(team.depthValue);
            return (
              <div
                key={team.roster.teamId}
                className={cn(
                  "px-4 sm:px-6 py-4 border-b border-border/50 grid grid-cols-12 gap-2 sm:gap-4 items-center hover:bg-muted/50 transition-colors min-w-[700px]",
                  team.roster.teamId === myTeamId && "bg-primary/5"
                )}
              >
                <div className="col-span-1">
                  <span
                    className={cn(
                      "text-sm font-bold",
                      idx === 0 && "text-yellow-400",
                      idx === 1 && "text-gray-400",
                      idx === 2 && "text-amber-600",
                      idx > 2 && "text-muted-foreground"
                    )}
                  >
                    {idx + 1}
                  </span>
                </div>

                <div className="col-span-3 md:col-span-3 lg:col-span-3 xl:col-span-3 2xl:col-span-3">
                  <div className="flex flex-wrap items-center gap-2 md:flex-nowrap lg:flex-nowrap xl:flex-nowrap 2xl:flex-nowrap">
                    <div className="flex-1">
                      <p className="text-sm font-semibold flex items-center gap-1.5">
                        {team.roster.teamName}
                        {team.roster.teamId === myTeamId && (
                          <Crown className="h-3.5 w-3.5 text-yellow-500" />
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{team.roster.ownerName}</p>
                    </div>
                    <Badge variant="outline" className={cn("text-[10px]", team.windowColor)}>
                      {team.windowLabel}
                    </Badge>
                  </div>
                  <div className="flex gap-1.5 mt-1">
                    {team.topPlayers.map((p) => (
                      <span key={p.id} className="text-[10px] text-muted-foreground">
                        {p.name.split(" ").pop()}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="col-span-1 text-right">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <span className={`text-sm font-black tabular-nums ${getRatingColor(overallRating)}`}>
                          {overallRating}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Total Value: {team.total.toLocaleString()}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>

                <div className="col-span-1 text-right">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <span className={`text-sm font-black tabular-nums ${getRatingColor(starterRating)}`}>
                          {starterRating}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Starter Value: {team.starterValue.toLocaleString()}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>

                <div className="col-span-1 text-right">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <span className={`text-sm font-black tabular-nums ${getRatingColor(depthRating)}`}>
                          {depthRating}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Depth Value: {team.depthValue.toLocaleString()}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>

                {currentWeek && (
                  <div className="col-span-1 text-right">
                    {team.weeklyProjection > 0 ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <span className="text-sm font-bold text-green-500 tabular-nums">
                              {team.weeklyProjection.toFixed(1)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Projected Points (Week {currentWeek.week})</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </div>
                )}

                <div className={cn("text-right", currentWeek ? "col-span-1" : "col-span-2")}>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {team.avgAge > 0 ? team.avgAge.toFixed(1) : "—"}
                  </span>
                </div>

                <div className={cn(currentWeek ? "col-span-3" : "col-span-4")}>
                  <div className="flex h-5 rounded overflow-hidden bg-muted mb-1">
                    {(["QB", "RB", "WR", "TE"] as const).map((pos) => {
                      const pct = team.grandTotal > 0 ? (team.posTotals[pos] / team.grandTotal) * 100 : 0;
                      if (pct < 0.1) return null;
                      return (
                        <div
                          key={pos}
                          className={posBarColors[pos]}
                          style={{ width: `${pct}%` }}
                          title={`${pos}: ${team.posTotals[pos].toLocaleString()} (${pct.toFixed(1)}%)`}
                        />
                      );
                    })}
                    {team.picksValue > 0 && (
                      <div
                        className={posBarColors.Picks}
                        style={{ width: `${(team.picksValue / team.grandTotal) * 100}%` }}
                        title={`Picks: ${team.picksValue.toLocaleString()}`}
                      />
                    )}
                  </div>
                  <div className="flex gap-2 justify-end flex-wrap">
                    {(["QB", "RB", "WR", "TE"] as const).map((pos) => (
                      <span key={pos} className="flex items-center gap-0.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-sm ${posBarColors[pos]}`} />
                        <span className="text-[9px] text-muted-foreground">{pos}</span>
                      </span>
                    ))}
                    {team.picksValue > 0 && (
                      <span className="flex items-center gap-0.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-sm ${posBarColors.Picks}`} />
                        <span className="text-[9px] text-muted-foreground">Picks</span>
                      </span>
                    )}
                  </div>
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
