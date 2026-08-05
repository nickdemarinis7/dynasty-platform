"use client";

import { useState, useMemo, useEffect } from "react";
import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_DYNASTY_VALUES } from "@/lib/player-values";
import { getCachedProjections, getCurrentNFLWeek } from "@/lib/projections-cache";
import type { PlayerProjection } from "@/lib/projections-api";
import { cn } from "@/lib/utils";
import { Search, TrendingUp, TrendingDown, ArrowUpDown, Filter, Activity, BarChart3, Info } from "lucide-react";

// Normalize any value to 0-100. Values > 150: FantasyCalc 0-10000 — divide by 100 and cap. Values 0-150: cap at 100.
const normVal = (v: number): number =>
  v > 150 ? Math.min(100, Math.round(v / 100)) : Math.min(100, v);

const positionColors: Record<string, string> = {
  QB: "text-red-400 border-red-500/30",
  RB: "text-green-400 border-green-500/30",
  WR: "text-blue-400 border-blue-500/30",
  TE: "text-orange-400 border-orange-500/30",
};

type SortField = "value" | "name" | "age" | "projection" | "posRank";
type SortDirection = "asc" | "desc";

export default function ValuesPage() {
  const { players, leagueSettings } = useAppStore();

  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState<string>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("value");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [showFilters, setShowFilters] = useState(false);
  const [projections, setProjections] = useState<Record<string, PlayerProjection>>({});
  const [currentWeek, setCurrentWeek] = useState<{ season: number; week: number } | null>(null);
  const [projectionsLoading, setProjectionsLoading] = useState(true);

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

  // Get player projection
  const getPlayerProjection = (playerId: string) => {
    const projection = projections[playerId];
    if (!projection?.stats) return null;
    
    const scoringType = leagueSettings?.scoringType === "ppr" ? "pts_ppr" : 
                        leagueSettings?.scoringType === "half_ppr" ? "pts_half_ppr" : "pts_std";
    
    return projection.stats[scoringType] || null;
  };

  // Build combined player list from store + defaults
  const allPlayers = useMemo(() => {
    const playerList: {
      id: string;
      name: string;
      position: string;
      team: string;
      age: number;
      injuryStatus?: string;
      byeWeek?: number;
      value: number;
      projection?: number | null;
    }[] = [];

    // From store (Sleeper imported)
    for (const [id, p] of Object.entries(players)) {
      if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      const projection = getPlayerProjection(id);
      playerList.push({
        id,
        name: p.name,
        position: p.position,
        team: p.team,
        age: p.age,
        injuryStatus: p.injuryStatus,
        byeWeek: p.byeWeek,
        value: normVal(p.dynastyValue || DEFAULT_DYNASTY_VALUES[p.name] || 10),
        projection: projection,
      });
    }

    // If no players loaded, show defaults
    if (playerList.length === 0) {
      for (const [name, value] of Object.entries(DEFAULT_DYNASTY_VALUES)) {
        if (name.includes("1st") || name.includes("2nd") || name.includes("3rd")) continue;
        playerList.push({
          id: name,
          name,
          position: guessPosition(name),
          team: "",
          age: 0,
          value: value,
        });
      }
    }

    return playerList;
  }, [players, projections, leagueSettings]);

  // Calculate position rankings
  const positionRankings = useMemo(() => {
    const rankings: Record<string, typeof allPlayers> = {};
    ["QB", "RB", "WR", "TE"].forEach(pos => {
      rankings[pos] = allPlayers
        .filter(p => p.position === pos)
        .sort((a, b) => b.value - a.value);
    });
    return rankings;
  }, [allPlayers]);

  // Get position rank for a player
  const getPositionRank = (player: typeof allPlayers[0]) => {
    const posPlayers = positionRankings[player.position] || [];
    return posPlayers.findIndex(p => p.id === player.id) + 1;
  };

  // Get value tier
  const getValueTier = (value: number) => {
    if (value >= 90) return "elite";
    if (value >= 70) return "premium";
    if (value >= 50) return "solid";
    if (value >= 30) return "depth";
    return "waiver";
  };

  // Get unique teams
  const teams = useMemo(() => {
    const teamSet = new Set(allPlayers.map(p => p.team).filter(Boolean));
    return Array.from(teamSet).sort();
  }, [allPlayers]);

  const filteredPlayers = useMemo(() => {
    let list = allPlayers;
    
    // Position filter
    if (posFilter !== "all") {
      list = list.filter((p) => p.position === posFilter);
    }
    
    // Team filter
    if (teamFilter !== "all") {
      list = list.filter((p) => p.team === teamFilter);
    }
    
    // Tier filter
    if (tierFilter !== "all") {
      list = list.filter((p) => {
        return getValueTier(p.value) === tierFilter;
      });
    }
    
    // Search filter
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    
    // Sorting
    list.sort((a, b) => {
      let aVal: number, bVal: number;
      
      switch (sortField) {
        case "value":
          aVal = a.value;
          bVal = b.value;
          break;
        case "name":
          return sortDirection === "asc" 
            ? a.name.localeCompare(b.name)
            : b.name.localeCompare(a.name);
        case "age":
          aVal = a.age;
          bVal = b.age;
          break;
        case "projection":
          aVal = a.projection || 0;
          bVal = b.projection || 0;
          break;
        case "posRank":
          aVal = getPositionRank(a);
          bVal = getPositionRank(b);
          break;
        default:
          aVal = a.value;
          bVal = b.value;
      }
      
      return sortDirection === "asc" ? aVal - bVal : bVal - aVal;
    });
    
    return list;
  }, [allPlayers, posFilter, teamFilter, tierFilter, search, sortField, sortDirection]);

  // Toggle sort
  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-bold tracking-tight gradient-text">Player Values</h1>
        <p className="text-muted-foreground mt-2 text-lg">
          Dynasty values from FantasyCalc based on ~1M real trades
        </p>
        <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            <span>{allPlayers.length} players</span>
          </div>
          {currentWeek && !projectionsLoading && (
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-green-500" />
              <span>Week {currentWeek.week} projections</span>
            </div>
          )}
        </div>
      </div>

      {/* Search and Filter */}
      <Card className="modern-card">
        <CardContent className="py-4 space-y-4">
          <div className="flex items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search players..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="h-4 w-4 mr-2" />
              Filters
            </Button>
          </div>
          
          {/* Position Filter */}
          <div className="flex gap-2">
            {["all", "QB", "RB", "WR", "TE"].map((pos) => (
              <button
                key={pos}
                onClick={() => setPosFilter(pos)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                  posFilter === pos
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-muted/80"
                )}
              >
                {pos === "all" ? "All" : pos}
              </button>
            ))}
          </div>
          
          {/* Advanced Filters */}
          {showFilters && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-border">
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Team</label>
                <select
                  value={teamFilter}
                  onChange={(e) => setTeamFilter(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                >
                  <option value="all">All Teams</option>
                  {teams.map(team => (
                    <option key={team} value={team}>{team}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Value Tier</label>
                <select
                  value={tierFilter}
                  onChange={(e) => setTierFilter(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                >
                  <option value="all">All Tiers</option>
                  <option value="elite">Elite (90+)</option>
                  <option value="premium">Premium (70-90)</option>
                  <option value="solid">Solid (50-70)</option>
                  <option value="depth">Depth (30-50)</option>
                  <option value="waiver">Waiver (&lt;30)</option>
                </select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Player List */}
      <Card className="modern-card">
        <CardContent className="p-0">
          <div className="px-6 py-3 border-b border-border grid grid-cols-[auto_auto_1fr_auto_auto_auto] gap-4 text-xs text-muted-foreground font-medium">
            <div className="w-12">Rank</div>
            <div className="w-12">Pos</div>
            <div>
              <button
                onClick={() => toggleSort("name")}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                Player
                <ArrowUpDown className="h-3 w-3" />
              </button>
            </div>
            <div className="text-right w-20">
              <button
                onClick={() => toggleSort("value")}
                className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
              >
                Value
                <ArrowUpDown className="h-3 w-3" />
              </button>
            </div>
            {currentWeek && (
              <div className="text-right w-20">
                <button
                  onClick={() => toggleSort("projection")}
                  className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
                >
                  Week {currentWeek.week}
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              </div>
            )}
            <div className="text-right w-24">
              <button
                onClick={() => toggleSort("posRank")}
                className="flex items-center gap-1 hover:text-foreground transition-colors ml-auto"
              >
                Pos Rank
                <ArrowUpDown className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {filteredPlayers.map((player, idx) => {
              const posRank = getPositionRank(player);
              
              const renderInjuryBadge = () => {
                if (!player.injuryStatus || player.injuryStatus === "active") return null;
                const statusColors: Record<string, string> = {
                  questionable: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
                  doubtful: "bg-orange-500/20 text-orange-400 border-orange-500/30",
                  out: "bg-red-500/20 text-red-400 border-red-500/30",
                  ir: "bg-red-500/20 text-red-400 border-red-500/30",
                };
                const status = player.injuryStatus.toLowerCase();
                return (
                  <Badge variant="outline" className={cn("text-xs", statusColors[status] || "bg-gray-500/20")}>
                    {status === "questionable" ? "Q" : status === "doubtful" ? "D" : status.toUpperCase()}
                  </Badge>
                );
              };

              return (
                <div
                  key={player.id}
                  className="px-6 py-3 border-b border-border/50 grid grid-cols-[auto_auto_1fr_auto_auto_auto] gap-4 items-center hover:bg-muted/50 transition-colors"
                >
                  <div className="w-12 text-sm text-muted-foreground font-medium">
                    #{idx + 1}
                  </div>
                  <div className="w-12">
                    <Badge
                      variant="outline"
                      className={cn("w-10 justify-center text-xs", positionColors[player.position] || "")}
                    >
                      {player.position}
                    </Badge>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{player.name}</span>
                      {renderInjuryBadge()}
                      {player.team && (
                        <span className="text-xs text-muted-foreground">
                          {player.team}
                        </span>
                      )}
                      {player.age > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {player.age}y
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="w-20 text-right">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <div className="text-sm font-mono font-semibold cursor-help">
                            {player.value.toLocaleString()}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Market value from FantasyCalc</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  {currentWeek && (
                    <div className="w-20 text-right">
                      {player.projection !== null && player.projection !== undefined ? (
                        <div className="flex items-center justify-end gap-1">
                          <Activity className="h-3 w-3 text-green-500" />
                          <span className="text-sm font-mono text-green-500">
                            {player.projection.toFixed(1)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </div>
                  )}
                  <div className="w-24 text-right">
                    <Badge variant="outline" className="text-xs">
                      {player.position}{posRank}
                    </Badge>
                  </div>
                </div>
              );
            })}
            {filteredPlayers.length === 0 && (
              <div className="px-6 py-12 text-center text-muted-foreground">
                No players found matching your filters
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Value Scale Reference */}
      <Card className="modern-card">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Info className="h-5 w-5" />
            Value Scale Reference
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold text-green-400">90+</p>
              <p className="text-sm text-muted-foreground mt-1">Elite</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold text-blue-400">70-90</p>
              <p className="text-sm text-muted-foreground mt-1">Premium</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold text-yellow-400">50-70</p>
              <p className="text-sm text-muted-foreground mt-1">Solid</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold text-orange-400">30-50</p>
              <p className="text-sm text-muted-foreground mt-1">Depth</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold text-red-400">&lt;30</p>
              <p className="text-sm text-muted-foreground mt-1">Waiver</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function guessPosition(name: string): string {
  const qbs = ["Allen", "Jackson", "Hurts", "Mahomes", "Burrow", "Stroud", "Richardson", "Daniels", "Williams", "Maye", "Purdy", "Prescott", "Love", "Murray", "Tagovailoa", "Lawrence", "Herbert", "Goff", "Mayfield", "Darnold", "Nix", "Stafford", "Rodgers", "Cousins", "Wilson", "Watson", "Jones", "Young"];
  const tes = ["LaPorta", "Bowers", "McBride", "Kelce", "Andrews", "Kittle", "Goedert", "Pitts", "Njoku", "Kincaid", "Engram", "Hockenson", "Freiermuth", "Ferguson"];
  
  if (qbs.some((q) => name.includes(q) && !name.includes("Jr"))) return "QB";
  if (tes.some((t) => name.includes(t))) return "TE";
  
  const rbs = ["Robinson", "Hall", "Gibbs", "Taylor", "Barkley", "Achane", "Walker", "Kyren", "Jacobs", "Henry", "Pacheco", "Cook", "Etienne", "Kamara", "Jones", "White", "Harris", "Montgomery", "Stevenson", "Pollard", "Javonte", "Moss", "Mixon", "Chubb", "Brooks", "Benson", "Corum", "Irving"];
  if (rbs.some((r) => name.includes(r))) return "RB";
  return "WR";
}
