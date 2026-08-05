"use client";

import { useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { computeAllProjections, AVG_FPPG } from "@/lib/projections";
import type { PlayerProjection } from "@/types";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
  Zap,
  Target,
  BarChart2,
  Users,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

type PosFilter = "ALL" | "QB" | "RB" | "WR" | "TE";
type RecFilter = "ALL" | "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL";
type SortKey = "edgeDelta" | "edgeScore" | "valueDelta1yr" | "currentValue" | "fppg";

const recConfig: Record<string, { label: string; color: string; bg: string }> = {
  STRONG_BUY:  { label: "STRONG BUY",  color: "text-emerald-400", bg: "bg-emerald-500/15 border-emerald-500/30" },
  BUY:         { label: "BUY",         color: "text-green-400",   bg: "bg-green-500/15 border-green-500/30" },
  HOLD:        { label: "HOLD",        color: "text-gray-400",    bg: "bg-gray-500/15 border-gray-500/30" },
  SELL:        { label: "SELL",        color: "text-orange-400",  bg: "bg-orange-500/15 border-orange-500/30" },
  STRONG_SELL: { label: "STRONG SELL", color: "text-red-400",     bg: "bg-red-500/15 border-red-500/30" },
};

const posColors: Record<string, string> = {
  QB: "text-red-400 border-red-500/30",
  RB: "text-green-400 border-green-500/30",
  WR: "text-blue-400 border-blue-500/30",
  TE: "text-orange-400 border-orange-500/30",
};

function TrajectoryIcon({ label }: { label: PlayerProjection["trajectoryLabel"] }) {
  if (label === "RISING")     return <TrendingUp  className="h-3.5 w-3.5 text-green-400" />;
  if (label === "DECLINING")  return <TrendingDown className="h-3.5 w-3.5 text-red-400" />;
  if (label === "PEAK")       return <Zap className="h-3.5 w-3.5 text-yellow-400" />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

function EdgeDeltaBadge({ delta }: { delta: number }) {
  const color = delta >= 8 ? "text-green-400" : delta <= -8 ? "text-red-400" : "text-muted-foreground";
  const sign  = delta > 0 ? "+" : "";
  return <span className={`text-xs font-bold font-mono ${color}`}>{sign}{delta}</span>;
}

function MiniBar({ value, max = 100, color }: { value: number; max?: number; color: string }) {
  return (
    <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  );
}

export default function ProjectionsPage() {
  const { rosters, leagueSettings, playerStats, statsLoading, statsLastFetched, loadPlayerStats } = useAppStore();

  const [posFilter,  setPosFilter]  = useState<PosFilter>("ALL");
  const [recFilter,  setRecFilter]  = useState<RecFilter>("ALL");
  const [sortKey,    setSortKey]    = useState<SortKey>("edgeDelta");
  const [sortDesc,   setSortDesc]   = useState(true);
  const [expanded,   setExpanded]   = useState<string | null>(null);

  const allRosteredPlayers = useMemo(() =>
    rosters.flatMap((r) => r.players), [rosters]
  );

  const projections = useMemo(() => {
    if (!leagueSettings || allRosteredPlayers.length === 0) return {};
    return computeAllProjections(allRosteredPlayers, leagueSettings, playerStats);
  }, [allRosteredPlayers, leagueSettings, playerStats]);

  const playerById = useMemo(() => {
    const map: Record<string, (typeof allRosteredPlayers)[0]> = {};
    for (const p of allRosteredPlayers) map[p.id] = p;
    return map;
  }, [allRosteredPlayers]);

  const rosterByPlayerId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const r of rosters) {
      for (const p of r.players) map[p.id] = r.teamName;
    }
    return map;
  }, [rosters]);

  const sorted = useMemo(() => {
    return Object.entries(projections)
      .filter(([, p]) => {
        if (posFilter !== "ALL" && playerById[p.playerId]?.position !== posFilter) return false;
        if (recFilter !== "ALL" && p.recommendation !== recFilter) return false;
        return true;
      })
      .sort(([, a], [, b]) => {
        const getSortVal = (p: PlayerProjection): number => {
          if (sortKey === "edgeDelta")    return p.edgeDelta;
          if (sortKey === "edgeScore")    return p.edgeScore;
          if (sortKey === "valueDelta1yr") return p.valueDelta1yr;
          if (sortKey === "currentValue") return p.currentValue;
          if (sortKey === "fppg")         return p.fppg ?? -1;
          return 0;
        };
        return sortDesc ? getSortVal(b) - getSortVal(a) : getSortVal(a) - getSortVal(b);
      });
  }, [projections, posFilter, recFilter, sortKey, sortDesc, playerById]);

  // Summary stats
  const summaryStats = useMemo(() => {
    const all = Object.values(projections);
    if (all.length === 0) return null;
    return {
      strongBuy:  all.filter(p => p.recommendation === "STRONG_BUY").length,
      buy:        all.filter(p => p.recommendation === "BUY").length,
      hold:       all.filter(p => p.recommendation === "HOLD").length,
      sell:       all.filter(p => p.recommendation === "SELL").length,
      strongSell: all.filter(p => p.recommendation === "STRONG_SELL").length,
      avgEdge:    Math.round(all.reduce((s, p) => s + p.edgeScore, 0) / all.length),
      hasStats:   Object.keys(playerStats).length > 0,
    };
  }, [projections, playerStats]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc(!sortDesc);
    else { setSortKey(key); setSortDesc(true); }
  };

  const lastFetchedStr = statsLastFetched
    ? new Date(statsLastFetched).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  if (rosters.length === 0 || !leagueSettings) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight gradient-text">Edge Intelligence</h1>
          <p className="text-muted-foreground mt-2 text-lg">Proprietary player projections powered by trajectory + production + team fit</p>
        </div>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-lg font-semibold mb-2">No League Data</h2>
            <p className="text-muted-foreground">Import your league first to generate projections.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold tracking-tight gradient-text">Edge Intelligence</h1>
            <p className="text-muted-foreground mt-2 text-lg">
              Proprietary projections — trajectory curves · production efficiency · team fit · composite Edge Score
            </p>
          </div>
          <div className="flex items-center gap-3 pt-1">
            {lastFetchedStr && (
              <span className="text-xs text-muted-foreground">Stats: {lastFetchedStr}</span>
            )}
            <button
              onClick={() => loadPlayerStats("2025")}
              disabled={statsLoading}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-sm font-medium disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${statsLoading ? "animate-spin" : ""}`} />
              {statsLoading ? "Loading…" : lastFetchedStr ? "Refresh Stats" : "Load 2025 Stats"}
            </button>
          </div>
        </div>
        
        {/* Metric Legend */}
        <div className="mt-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500 mt-1 shrink-0"></div>
            <div>
              <span className="font-semibold text-foreground">Edge Δ</span>
              <p className="text-muted-foreground">Value vs market consensus</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500 mt-1 shrink-0"></div>
            <div>
              <span className="font-semibold text-foreground">Score</span>
              <p className="text-muted-foreground">Overall edge rating (0-100)</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-yellow-500 mt-1 shrink-0"></div>
            <div>
              <span className="font-semibold text-foreground">1yr Δ</span>
              <p className="text-muted-foreground">Projected value change</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-purple-500 mt-1 shrink-0"></div>
            <div>
              <span className="font-semibold text-foreground">FPPG</span>
              <p className="text-muted-foreground">Fantasy points per game</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-orange-500 mt-1 shrink-0"></div>
            <div>
              <span className="font-semibold text-foreground">Traj/Fit</span>
              <p className="text-muted-foreground">Career + team situation</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-2 h-2 rounded-full bg-red-500 mt-1 shrink-0"></div>
            <div>
              <span className="font-semibold text-foreground">Signal</span>
              <p className="text-muted-foreground">Buy/Sell recommendation</p>
            </div>
          </div>
        </div>
      </div>

      {/* Stats banner if no real stats yet */}
      {!summaryStats?.hasStats && (
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="py-3 flex items-center gap-3">
            <AlertCircle className="h-4 w-4 text-yellow-400 shrink-0" />
            <p className="text-sm text-yellow-300">
              Showing <strong>Tier 1 trajectory-only projections</strong> — load 2025 stats to unlock production scoring and team fit analysis.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Summary row */}
      {summaryStats && (
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: "Strong Buy", val: summaryStats.strongBuy, color: "text-emerald-400" },
            { label: "Buy",        val: summaryStats.buy,       color: "text-green-400" },
            { label: "Hold",       val: summaryStats.hold,      color: "text-gray-400" },
            { label: "Sell",       val: summaryStats.sell,      color: "text-orange-400" },
            { label: "Strong Sell",val: summaryStats.strongSell,color: "text-red-400" },
          ].map(({ label, val, color }) => (
            <Card key={label} className="modern-card">
              <CardContent className="py-3 text-center">
                <p className={`text-xl font-bold font-mono ${color}`}>{val}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Filters + sort controls */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          {(["ALL", "QB", "RB", "WR", "TE"] as PosFilter[]).map((p) => (
            <button key={p} onClick={() => setPosFilter(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${posFilter === p ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}>
              {p}
            </button>
          ))}
        </div>
        <Separator orientation="vertical" className="h-6" />
        <div className="flex items-center gap-1.5">
          {(["ALL", "STRONG_BUY", "BUY", "HOLD", "SELL", "STRONG_SELL"] as RecFilter[]).map((r) => (
            <button key={r} onClick={() => setRecFilter(r)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${recFilter === r ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}>
              {recConfig[r]?.label ?? r}
            </button>
          ))}
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-12 gap-2 px-4 py-2 text-xs font-semibold bg-muted/30 rounded-lg border border-border/50">
        <div className="col-span-4 text-muted-foreground">PLAYER</div>
        <div className="col-span-1 text-center cursor-pointer hover:text-foreground transition-colors text-muted-foreground" onClick={() => toggleSort("edgeDelta")} title="Value vs market consensus">
          EDGE Δ {sortKey === "edgeDelta" ? (sortDesc ? "↓" : "↑") : ""}
        </div>
        <div className="col-span-1 text-center cursor-pointer hover:text-foreground transition-colors text-muted-foreground" onClick={() => toggleSort("edgeScore")} title="Overall edge rating (0-100)">
          SCORE {sortKey === "edgeScore" ? (sortDesc ? "↓" : "↑") : ""}
        </div>
        <div className="col-span-1 text-center cursor-pointer hover:text-foreground transition-colors text-muted-foreground" onClick={() => toggleSort("valueDelta1yr")} title="Projected value change in 1 year">
          1YR Δ {sortKey === "valueDelta1yr" ? (sortDesc ? "↓" : "↑") : ""}
        </div>
        <div className="col-span-1 text-center cursor-pointer hover:text-foreground transition-colors text-muted-foreground" onClick={() => toggleSort("fppg")} title="Fantasy points per game">
          FPPG {sortKey === "fppg" ? (sortDesc ? "↓" : "↑") : ""}
        </div>
        <div className="col-span-2 text-center text-muted-foreground" title="Career trajectory & team fit scores">TRAJ / FIT</div>
        <div className="col-span-2 text-right text-muted-foreground" title="Buy/Sell recommendation">SIGNAL</div>
      </div>

      {/* Player rows */}
      <div className="space-y-1.5">
        {sorted.map(([id, proj]) => {
          const player = playerById[id];
          if (!player) return null;
          const cfg = recConfig[proj.recommendation];
          const isExpanded = expanded === id;
          const deltaSign = proj.valueDelta1yr >= 0 ? "+" : "";
          const fppgAvg = AVG_FPPG[player.position];
          const fppgVsAvg = proj.fppg !== undefined && fppgAvg
            ? Math.round(((proj.fppg - fppgAvg) / fppgAvg) * 100)
            : null;

          return (
            <Card key={id} className={`modern-card cursor-pointer border-border/50 hover:border-border transition-all ${isExpanded ? "border-primary/30" : ""}`}
              onClick={() => setExpanded(isExpanded ? null : id)}>
              <CardContent className="py-3">
                <div className="grid grid-cols-12 gap-2 items-center">
                  {/* Player info */}
                  <div className="col-span-4 flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className={`text-xs shrink-0 ${posColors[player.position] ?? ""}`}>
                      {player.position}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{player.name}</p>
                      <p className="text-xs text-muted-foreground">{player.team} · Age {player.age}</p>
                    </div>
                  </div>

                  {/* Edge Delta */}
                  <div className="col-span-1 text-center">
                    <EdgeDeltaBadge delta={proj.edgeDelta} />
                  </div>

                  {/* Edge Score bar */}
                  <div className="col-span-1 text-center">
                    <span className="text-sm font-bold font-mono">{proj.edgeScore}</span>
                    <MiniBar value={proj.edgeScore} color={proj.edgeScore >= 60 ? "bg-green-500" : proj.edgeScore >= 40 ? "bg-yellow-500" : "bg-red-500"} />
                  </div>

                  {/* 1yr value delta */}
                  <div className="col-span-1 text-center">
                    <span className={`text-xs font-medium ${proj.valueDelta1yr >= 0.05 ? "text-green-400" : proj.valueDelta1yr <= -0.10 ? "text-red-400" : "text-muted-foreground"}`}>
                      {deltaSign}{Math.round(proj.valueDelta1yr * 100)}%
                    </span>
                  </div>

                  {/* FPPG */}
                  <div className="col-span-1 text-center">
                    {proj.fppg !== undefined ? (
                      <div>
                        <span className="text-xs font-mono">{proj.fppg.toFixed(1)}</span>
                        {fppgVsAvg !== null && (
                          <span className={`text-xs ml-1 ${fppgVsAvg >= 20 ? "text-green-400" : fppgVsAvg <= -20 ? "text-red-400" : "text-muted-foreground"}`}>
                            {fppgVsAvg > 0 ? "+" : ""}{fppgVsAvg}%
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">—</span>
                    )}
                  </div>

                  {/* Trajectory + team fit mini bars */}
                  <div className="col-span-2 flex items-center gap-2">
                    <TrajectoryIcon label={proj.trajectoryLabel} />
                    <div className="flex-1 space-y-0.5">
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground w-4">P</span>
                        <MiniBar value={proj.productionScore} color="bg-blue-500" />
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground w-4">F</span>
                        <MiniBar value={proj.teamFitScore} color="bg-purple-500" />
                      </div>
                    </div>
                  </div>

                  {/* Recommendation + expand */}
                  <div className="col-span-2 flex items-center justify-end gap-2">
                    <Badge variant="outline" className={`text-xs ${cfg?.color} ${cfg?.bg}`}>
                      {cfg?.label}
                    </Badge>
                    {isExpanded
                      ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    }
                  </div>
                </div>

                {/* Expanded detail panel */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-border/40 grid grid-cols-2 gap-4">
                    {/* Signals */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">Signals</p>
                      <ul className="space-y-1">
                        {proj.signals.map((s, i) => (
                          <li key={i} className="text-xs text-foreground/80">{s}</li>
                        ))}
                        {proj.signals.length === 0 && (
                          <li className="text-xs text-muted-foreground">No strong signals</li>
                        )}
                      </ul>
                    </div>

                    {/* Value trajectory */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">Value Trajectory</p>
                      <div className="space-y-1.5">
                        {[
                          { label: "Now",   value: proj.currentValue },
                          { label: "+1yr",  value: proj.projectedValue1yr },
                          { label: "+3yr",  value: proj.projectedValue3yr },
                        ].map(({ label, value }) => (
                          <div key={label} className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground w-8">{label}</span>
                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary/60 rounded-full"
                                style={{ width: `${Math.min(100, value / 100)}%` }}
                              />
                            </div>
                            <span className="text-xs font-mono text-muted-foreground w-12 text-right">{value.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">On</span>
                        <span className="text-xs font-medium">{rosterByPlayerId[id] ?? "—"}</span>
                      </div>
                    </div>

                    {/* Share stats if available */}
                    {(proj.targetShare !== undefined || proj.rushShare !== undefined) && (
                      <div className="col-span-2 pt-2 border-t border-border/30">
                        <p className="text-xs font-medium text-muted-foreground mb-2">Team Fit Breakdown</p>
                        <div className="flex gap-6">
                          {proj.targetShare !== undefined && (
                            <div>
                              <p className="text-xs text-muted-foreground">Target Share</p>
                              <p className="text-sm font-bold font-mono">{Math.round(proj.targetShare * 100)}%</p>
                            </div>
                          )}
                          {proj.rushShare !== undefined && (
                            <div>
                              <p className="text-xs text-muted-foreground">Rush Share</p>
                              <p className="text-sm font-bold font-mono">{Math.round(proj.rushShare * 100)}%</p>
                            </div>
                          )}
                          <div>
                            <p className="text-xs text-muted-foreground">Production Score</p>
                            <p className="text-sm font-bold font-mono">{proj.productionScore}/100</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Team Fit Score</p>
                            <p className="text-sm font-bold font-mono">{proj.teamFitScore}/100</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}

        {sorted.length === 0 && (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">No players match the current filters.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
