"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Loader2,
  RefreshCw,
  Clock,
  TrendingUp,
  TrendingDown,
  Trophy,
  Radio,
} from "lucide-react";

const positionColors: Record<string, string> = {
  QB: "bg-red-500/20 text-red-400 border-red-500/30",
  RB: "bg-green-500/20 text-green-400 border-green-500/30",
  WR: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  TE: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

interface DraftData {
  draft: { id: string; status: string; type: string; season: string; rounds: number; teams: number; leagueMode: "dynasty" | "keeper" | "redraft" };
  meta: { totalPicks: number; picksMade: number; isComplete: boolean; currentPickNo: number | null; currentRound: number | null; lastPicked: number | null };
  onClock: { rosterId: number; teamName: string; isMine: boolean } | null;
  me: { rosterId: number | null; teamName: string | null; nextPickNo: number | null; picksUntilMyTurn: number | null; upcomingPicks: number[]; positionCounts: Record<string, number> };
  recentPicks: Array<{ pickNo: number; round: number; slot: number; playerName: string; position: string; team: string; rosterId: number; teamName: string; value: number; isMine: boolean }>;
  bestAvailable: Array<{ id: string; name: string; position: string; team: string; age: number | null; value: number; positionRank: number | null; overallRank: number | null; trend30Day: number }>;
}

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE"];

export default function DraftPage() {
  const { sleeperLeagueId, sleeperUsername } = useAppStore();
  const [data, setData] = useState<DraftData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState("ALL");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchDraft = useCallback(async () => {
    if (!sleeperLeagueId || !sleeperUsername) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/sleeper/draft?leagueId=${sleeperLeagueId}&username=${encodeURIComponent(sleeperUsername)}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load draft");
      setData(json);
      setLastUpdated(new Date());
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "Failed to load draft");
    } finally {
      setLoading(false);
    }
  }, [sleeperLeagueId, sleeperUsername]);

  useEffect(() => {
    // Loading remote data on mount is the synchronization this effect owns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchDraft();
  }, [fetchDraft]);

  // Auto-refresh every 15s while draft is live
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh && data && !data.meta.isComplete) {
      intervalRef.current = setInterval(fetchDraft, 15000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, data, fetchDraft]);

  if (!sleeperLeagueId) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Live Draft</h1>
          <p className="text-muted-foreground mt-1">Connect your league first to track the draft</p>
        </div>
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-muted-foreground">
            Go to <span className="text-foreground font-medium">League Setup</span> to connect your Sleeper league.
          </CardContent>
        </Card>
      </div>
    );
  }

  const filteredAvailable =
    data?.bestAvailable.filter((p) => posFilter === "ALL" || p.position === posFilter) ?? [];

  // Determine positional needs (fewest at position = higher need)
  const counts = data?.me.positionCounts ?? {};
  const needHint = (pos: string): boolean => {
    if (pos === "QB") return (counts.QB ?? 0) < 3;
    if (pos === "TE") return (counts.TE ?? 0) < 3;
    if (pos === "RB") return (counts.RB ?? 0) < 6;
    if (pos === "WR") return (counts.WR ?? 0) < 7;
    return false;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            Live Draft
            {data && !data.meta.isComplete && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-1 rounded-full">
                <Radio className="h-3 w-3 animate-pulse" /> LIVE
              </span>
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            {data ? `${data.draft.season} Rookie Draft · ${data.draft.rounds} rounds · ${data.draft.type}` : "Loading draft..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <Button
            variant={autoRefresh ? "secondary" : "outline"}
            size="sm"
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? "Auto: On" : "Auto: Off"}
          </Button>
          <Button variant="outline" size="sm" onClick={fetchDraft} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/30">
          <CardContent className="py-4 text-destructive text-sm">{error}</CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* On the clock + my pick status */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card
              className={cn(
                "md:col-span-2",
                data.onClock?.isMine && "border-green-500/50 bg-green-500/10"
              )}
            >
              <CardContent className="py-5">
                {data.meta.isComplete ? (
                  <div className="flex items-center gap-3">
                    <Trophy className="h-8 w-8 text-yellow-500" />
                    <div>
                      <p className="font-semibold text-lg">Draft Complete</p>
                      <p className="text-sm text-muted-foreground">All {data.meta.totalPicks} picks are in</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Clock className={cn("h-8 w-8", data.onClock?.isMine ? "text-green-400" : "text-muted-foreground")} />
                      <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">On the Clock</p>
                        <p className="font-semibold text-lg">
                          {data.onClock?.isMine ? "You're up!" : data.onClock?.teamName}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold font-mono">#{data.meta.currentPickNo}</p>
                      <p className="text-xs text-muted-foreground">
                        Round {data.meta.currentRound} · {data.meta.picksMade}/{data.meta.totalPicks}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="py-5">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Your Next Pick</p>
                {data.me.nextPickNo ? (
                  <>
                    <p className="font-semibold text-lg">Pick #{data.me.nextPickNo}</p>
                    <p className="text-sm text-muted-foreground">
                      {data.me.picksUntilMyTurn === 0
                        ? "On the clock now"
                        : `${data.me.picksUntilMyTurn} pick${data.me.picksUntilMyTurn === 1 ? "" : "s"} away`}
                    </p>
                  </>
                ) : (
                  <p className="font-semibold text-lg text-muted-foreground">No more picks</p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Best Available */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5" /> Best Available
                  </CardTitle>
                  <div className="flex gap-1">
                    {POSITIONS.map((pos) => (
                      <button
                        key={pos}
                        onClick={() => setPosFilter(pos)}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                          posFilter === pos
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted"
                        )}
                      >
                        {pos}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-1">
                {filteredAvailable.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No available players.</p>
                ) : (
                  filteredAvailable.slice(0, 30).map((p, idx) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-muted/50 transition-colors"
                    >
                      <span className="text-xs text-muted-foreground w-5 text-right">{idx + 1}</span>
                      <Badge variant="outline" className={cn("w-12 justify-center text-xs", positionColors[p.position])}>
                        {p.position}
                        {p.positionRank ?? ""}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate flex items-center gap-1.5">
                          {p.name}
                          {needHint(p.position) && (
                            <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">NEED</span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {p.team} {p.age ? `· ${p.age}y` : ""}
                        </p>
                      </div>
                      {p.trend30Day !== 0 && (
                        <span className={cn("text-xs flex items-center gap-0.5", p.trend30Day > 0 ? "text-green-400" : "text-red-400")}>
                          {p.trend30Day > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                          {Math.abs(p.trend30Day)}
                        </span>
                      )}
                      <span className="text-sm font-mono font-semibold w-14 text-right">{p.value.toLocaleString()}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Recent Picks */}
            <Card>
              <CardHeader>
                <CardTitle>Recent Picks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {data.recentPicks.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No picks yet.</p>
                ) : (
                  data.recentPicks.map((p) => (
                    <div
                      key={p.pickNo}
                      className={cn(
                        "flex items-center gap-2 px-2 py-1.5 rounded-lg",
                        p.isMine && "bg-green-500/10"
                      )}
                    >
                      <span className="text-xs text-muted-foreground font-mono w-12">
                        {p.round}.{String(p.slot).padStart(2, "0")}
                      </span>
                      <Badge variant="outline" className={cn("w-9 justify-center text-[10px]", positionColors[p.position])}>
                        {p.position}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{p.playerName}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{p.teamName}</p>
                      </div>
                      <span className="text-xs font-mono text-muted-foreground">{p.value > 0 ? p.value.toLocaleString() : "-"}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
