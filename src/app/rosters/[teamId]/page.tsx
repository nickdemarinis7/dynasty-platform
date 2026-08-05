"use client";

import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_DYNASTY_VALUES } from "@/lib/player-values";
import { optimizeLineup, getLineupDisplay } from "@/lib/lineup-optimizer";
import { getCachedProjections, getCurrentNFLWeek } from "@/lib/projections-cache";
import { cn } from "@/lib/utils";
import { Crown, ArrowLeft, TrendingUp, User, Info, Flame, Package, AlertCircle, Activity } from "lucide-react";
import { useRouter, useParams } from "next/navigation";
import { useMemo, useEffect, useState } from "react";
import type { PlayerProjection } from "@/lib/projections-api";

const positionColors: Record<string, string> = {
  QB: "bg-red-500/20 text-red-400 border-red-500/30",
  RB: "bg-green-500/20 text-green-400 border-green-500/30",
  WR: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  TE: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  FLEX: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  SUPERFLEX: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  K: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  DEF: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  BN: "bg-slate-500/20 text-slate-400 border-slate-500/30",
};

export default function RosterDetailPage() {
  const { rosters, myTeamId, personalValues, leagueSettings } = useAppStore();
  const router = useRouter();
  const params = useParams();
  const teamId = params.teamId as string;
  const [projections, setProjections] = useState<Record<string, PlayerProjection>>({});
  const [projectionsLoading, setProjectionsLoading] = useState(true);
  const [currentWeek, setCurrentWeek] = useState<{ season: number; week: number; isPlayoffs: boolean } | null>(null);

  const roster = rosters.find((r) => r.teamId === teamId);

  // Fetch projections on mount
  useEffect(() => {
    async function fetchProjections() {
      try {
        setProjectionsLoading(true);
        const nflWeek = getCurrentNFLWeek();
        setCurrentWeek(nflWeek);
        const projs = await getCachedProjections(nflWeek.season, nflWeek.week);
        setProjections(projs);
      } catch (error) {
        console.error("Failed to fetch projections:", error);
      } finally {
        setProjectionsLoading(false);
      }
    }
    fetchProjections();
  }, []);

  const getPlayerValue = (player: { id: string; name: string; dynastyValue: number }) => {
    if (personalValues[player.id]) return personalValues[player.id];
    return player.dynastyValue || DEFAULT_DYNASTY_VALUES[player.name] || 0;
  };

  const getRosterValue = (roster: typeof rosters[0]) => {
    return roster.players.reduce((sum, p) => sum + getPlayerValue(p), 0);
  };

  // Use lineup optimizer for accurate starters/bench
  const optimizedLineup = useMemo(() => {
    if (!roster || !leagueSettings) return null;
    
    const scoringType = leagueSettings.scoringType === "ppr" ? "ppr" : 
                        leagueSettings.scoringType === "half_ppr" ? "half_ppr" : "std";
    
    return optimizeLineup(
      roster.players,
      leagueSettings,
      currentWeek?.isPlayoffs || false,
      currentWeek?.week,
      projections,
      scoringType
    );
  }, [roster, leagueSettings, projections, currentWeek]);

  const starters = optimizedLineup?.starters || [];
  const bench = optimizedLineup?.bench || [];
  const totalProjectedPoints = optimizedLineup?.totalProjectedPoints || 0;

  // Get lineup display with proper slots - use projections if available
  const lineupSlots = useMemo(() => {
    if (!roster || !leagueSettings) return [];
    
    // If we have projections and current week, use optimizeLineup which considers projections
    if (Object.keys(projections).length > 0 && currentWeek) {
      const scoringType = leagueSettings.scoringType === "ppr" ? "ppr" : 
                          leagueSettings.scoringType === "half_ppr" ? "half_ppr" : "std";
      
      const optimized = optimizeLineup(
        roster.players,
        leagueSettings,
        currentWeek.isPlayoffs || false,
        currentWeek.week,
        projections,
        scoringType as "ppr" | "half_ppr" | "std"
      );
      
      // Build slots from optimized lineup with proper slot identification
      const slots: Array<{ position: string; player: typeof roster.players[0] | null }> = [];
      
      // Count how many of each position and flex type we've assigned
      const positionCounts: Record<string, number> = {};
      let flexUsed = 0;
      let superflexUsed = 0;
      
      // Get slot configuration
      const rosterSlots = leagueSettings.rosterSlots.filter(s => s.type !== "BN" && s.type !== "IR");
      const flexSlotCount = rosterSlots.find(s => s.type === "FLEX")?.count || 0;
      const superflexSlotCount = rosterSlots.find(s => s.type === "SUPERFLEX")?.count || 0;
      
      optimized.starters.forEach(player => {
        positionCounts[player.position] = (positionCounts[player.position] || 0) + 1;
        
        // Find the appropriate slot for this player
        const positionSlot = rosterSlots.find(s => s.type === player.position);
        const positionIndex = positionCounts[player.position] - 1;
        
        let slotType: string = player.position;
        
        // If this player exceeds their position-specific slots, they're in FLEX or SUPERFLEX
        if (positionSlot && positionIndex >= positionSlot.count) {
          // FLEX accepts RB/WR/TE, SUPERFLEX accepts QB/RB/WR/TE
          const isFlexEligible = ["RB", "WR", "TE"].includes(player.position);
          const isSuperflexEligible = ["QB", "RB", "WR", "TE"].includes(player.position);
          
          // Fill FLEX slots first (if eligible), then SUPERFLEX
          if (isFlexEligible && flexUsed < flexSlotCount) {
            slotType = "FLEX";
            flexUsed++;
          } else if (isSuperflexEligible && superflexUsed < superflexSlotCount) {
            slotType = "SUPERFLEX";
            superflexUsed++;
          }
        }
        
        slots.push({ position: slotType, player });
      });
      
      return slots;
    }
    
    // Fallback to basic display
    return getLineupDisplay(roster.players, leagueSettings);
  }, [roster, leagueSettings, projections, currentWeek]);

  // Position breakdown - must be before early return
  const positionBreakdown = useMemo(() => {
    if (!roster) return {};
    const breakdown: Record<string, typeof roster.players> = {};
    roster.players.forEach(p => {
      if (!breakdown[p.position]) breakdown[p.position] = [];
      breakdown[p.position].push(p);
    });
    return breakdown;
  }, [roster]);

  // Get player's projected points
  const getPlayerProjection = (player: { id: string }) => {
    const projection = projections[player.id];
    if (!projection?.stats) return null;
    
    const scoringType = leagueSettings?.scoringType === "ppr" ? "pts_ppr" : 
                        leagueSettings?.scoringType === "half_ppr" ? "pts_half_ppr" : "pts_std";
    
    return projection.stats[scoringType] || null;
  };

  // Render injury badge
  const renderInjuryBadge = (player: { injuryStatus?: string }) => {
    if (!player.injuryStatus || player.injuryStatus === "active") return null;
    
    const statusColors: Record<string, string> = {
      questionable: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
      doubtful: "bg-orange-500/20 text-orange-400 border-orange-500/30",
      out: "bg-red-500/20 text-red-400 border-red-500/30",
      ir: "bg-red-500/20 text-red-400 border-red-500/30",
      suspended: "bg-red-500/20 text-red-400 border-red-500/30",
    };
    
    const statusLabels: Record<string, string> = {
      questionable: "Q",
      doubtful: "D",
      out: "OUT",
      ir: "IR",
      suspended: "SUS",
    };
    
    const status = player.injuryStatus.toLowerCase();
    return (
      <Badge variant="outline" className={cn("text-xs", statusColors[status] || "bg-gray-500/20")}>
        {statusLabels[status] || status.toUpperCase()}
      </Badge>
    );
  };

  if (!roster) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-4xl font-bold tracking-tight gradient-text">Roster Not Found</h1>
        </div>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">This roster doesn't exist or hasn't been loaded.</p>
            <Button onClick={() => router.push("/rosters")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Rosters
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const rosterValue = getRosterValue(roster);
  const isMyTeam = roster.teamId === myTeamId;
  const startersValue = starters.reduce((sum, p) => sum + getPlayerValue(p), 0);
  const benchValue = bench.reduce((sum, p) => sum + getPlayerValue(p), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/rosters")}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
      </div>

      {/* Roster Summary */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h1 className="text-4xl font-bold tracking-tight gradient-text">{roster.teamName}</h1>
              <p className="text-muted-foreground mt-1">{roster.ownerName}</p>
              {isMyTeam && (
                <Badge variant="secondary" className="gap-1 mt-2">
                  <Crown className="h-3 w-3" />
                  My Team
                </Badge>
              )}
            </div>
            {totalProjectedPoints > 0 && currentWeek && (
              <div className="text-right ml-6">
                <p className="text-4xl font-bold text-green-500">{totalProjectedPoints.toFixed(1)}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Week {currentWeek.week} Projection
                </p>
              </div>
            )}
            {projectionsLoading && (
              <div className="text-right ml-6">
                <p className="text-sm text-muted-foreground">Loading projections...</p>
              </div>
            )}
          </div>
        </CardHeader>
      </Card>

      {/* Starters */}
      <div>
        <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
          <Flame className="h-5 w-5 text-orange-500" />
          Starting Lineup
          <Badge variant="secondary">{lineupSlots.length}</Badge>
          {projectionsLoading ? (
            <span className="text-sm font-normal text-muted-foreground ml-2">Loading projections...</span>
          ) : totalProjectedPoints > 0 ? (
            <span className="text-sm font-normal text-muted-foreground ml-2">
              {totalProjectedPoints.toFixed(1)} projected pts
            </span>
          ) : currentWeek ? (
            <span className="text-sm font-normal text-muted-foreground ml-2">
              Week {currentWeek.week} • No projections available
            </span>
          ) : null}
        </h2>
        
        {/* Display by roster slots */}
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {lineupSlots.map((slot, index) => {
                const player = slot.player;
                const slotLabel = slot.position === "SUPERFLEX" ? "WRTQ" : 
                                  slot.position === "FLEX" ? "WRT" : 
                                  slot.position;
                
                if (!player) {
                  // Empty slot
                  return (
                    <div key={`${slot.position}-${index}`} className="flex items-center gap-3 px-4 py-3 opacity-50">
                      <Badge
                        variant="outline"
                        className={cn("w-14 justify-center shrink-0", positionColors[slot.position] || positionColors.BN)}
                      >
                        {slotLabel}
                      </Badge>
                      <p className="text-sm text-muted-foreground italic">Empty</p>
                    </div>
                  );
                }
                
                const projection = getPlayerProjection(player);
                
                return (
                  <div key={`${slot.position}-${player.id}-${index}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Badge
                        variant="outline"
                        className={cn("w-14 justify-center shrink-0", positionColors[slot.position] || positionColors[player.position])}
                      >
                        {slotLabel}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <p className="font-semibold text-sm truncate">{player.name}</p>
                          {slot.position !== player.position && (
                            <Badge variant="outline" className={cn("text-xs", positionColors[player.position])}>
                              {player.position}
                            </Badge>
                          )}
                          {renderInjuryBadge(player)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {player.team} {player.age > 0 && `• ${player.age}y`}
                          {player.byeWeek && ` • Bye: ${player.byeWeek}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 shrink-0">
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Value</p>
                        <p className="text-sm font-mono font-medium">
                          {getPlayerValue(player).toLocaleString()}
                        </p>
                      </div>
                      <div className="text-right min-w-[70px]">
                        <p className="text-xs text-muted-foreground">Proj Pts</p>
                        <div className="flex items-center gap-1 justify-end">
                          <Activity className="h-3 w-3 text-green-500" />
                          <span className="text-sm font-mono font-medium text-green-500">
                            {projection !== null ? projection.toFixed(1) : '—'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bench */}
      <div>
        <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
          <Package className="h-5 w-5 text-slate-500" />
          Bench
          <Badge variant="secondary">{bench.length}</Badge>
        </h2>
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {bench.map((player) => {
                const projection = getPlayerProjection(player);
                return (
                  <div
                    key={player.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Badge
                        variant="outline"
                        className={cn("w-14 justify-center shrink-0", positionColors[player.position])}
                      >
                        {player.position}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <p className="font-semibold text-sm truncate">{player.name}</p>
                          {renderInjuryBadge(player)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {player.team} {player.age > 0 && `• ${player.age}y`}
                          {player.byeWeek && ` • Bye: ${player.byeWeek}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 shrink-0">
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Value</p>
                        <p className="text-sm font-mono font-medium">
                          {getPlayerValue(player).toLocaleString()}
                        </p>
                      </div>
                      <div className="text-right min-w-[70px]">
                        <p className="text-xs text-muted-foreground">Proj Pts</p>
                        <div className="flex items-center gap-1 justify-end">
                          <Activity className="h-3 w-3 text-muted-foreground" />
                          <span className="text-sm font-mono font-medium text-muted-foreground">
                            {projection !== null ? projection.toFixed(1) : '—'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {bench.length === 0 && (
                <div className="px-4 py-8 text-center text-muted-foreground">
                  No bench players
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
