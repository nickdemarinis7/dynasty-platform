"use client";

import { useState, useMemo, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useAppStore } from "@/store";
import type { SavedTrade } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_DYNASTY_VALUES } from "@/lib/player-values";
import { buildLeagueContext, evaluateTrade } from "@/lib/trade-engine";
import type { Player, DraftPick } from "@/types";
import {
  ArrowRightLeft,
  X,
  Save,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

const positionColors: Record<string, string> = {
  QB: "text-red-400 border-red-500/30",
  RB: "text-green-400 border-green-500/30",
  WR: "text-blue-400 border-blue-500/30",
  TE: "text-orange-400 border-orange-500/30",
};

function pickLabel(pick: DraftPick): string {
  const r = pick.round === 1 ? "1st" : pick.round === 2 ? "2nd" : pick.round === 3 ? "3rd" : `${pick.round}th`;
  return `${pick.year} ${r}`;
}

function TradePageContent() {
  const searchParams = useSearchParams();
  const { rosters, myTeamId, personalValues, leagueSettings, addSavedTrade } = useAppStore();

  // Default Team B to the first team that's not Team A
  const defaultTeamBId = useMemo(() => {
    if (rosters.length === 0) return "";
    const firstTeam = rosters.find((r) => r.teamId !== myTeamId);
    return firstTeam?.teamId || "";
  }, [rosters, myTeamId]);

  const [teamAId, setTeamAId] = useState<string>(myTeamId || "");
  const [teamBId, setTeamBId] = useState<string>(defaultTeamBId);
  const [teamAPlayers, setTeamAPlayers] = useState<Player[]>([]);
  const [teamBPlayers, setTeamBPlayers] = useState<Player[]>([]);
  const [teamAPicks, setTeamAPicks] = useState<DraftPick[]>([]);
  const [teamBPicks, setTeamBPicks] = useState<DraftPick[]>([]);
  const [searchA, setSearchA] = useState("");
  const [searchB, setSearchB] = useState("");

  // Handle URL params for pre-filled trade from recommendations
  useEffect(() => {
    const teamAParam = searchParams.get("teamA");
    const teamBParam = searchParams.get("teamB");
    const playersA = searchParams.get("playersA");
    const playersB = searchParams.get("playersB");
    const picksA = searchParams.get("picksA");

    if (teamAParam) setTeamAId(teamAParam);
    if (teamBParam) setTeamBId(teamBParam);

    if (playersA && teamAParam) {
      const teamA = rosters.find((r) => r.teamId === teamAParam);
      if (teamA) {
        const playerIds = playersA.split(",");
        const players = playerIds
          .map((id) => teamA.players.find((p) => p.id === id))
          .filter((p): p is Player => p !== undefined);
        setTeamAPlayers(players);
      }
    }

    if (playersB && teamBParam) {
      const teamB = rosters.find((r) => r.teamId === teamBParam);
      if (teamB) {
        const playerIds = playersB.split(",");
        const players = playerIds
          .map((id) => teamB.players.find((p) => p.id === id))
          .filter((p): p is Player => p !== undefined);
        setTeamBPlayers(players);
      }
    }

    if (picksA && teamAParam) {
      const teamA = rosters.find((r) => r.teamId === teamAParam);
      if (teamA) {
        const pickSpecs = picksA.split(",");
        const picks = pickSpecs
          .map((spec) => {
            const [year, round] = spec.split("-").map(Number);
            return teamA.draftPicks.find(p => p.year === year && p.round === round);
          })
          .filter((p): p is DraftPick => p !== undefined);
        setTeamAPicks(picks);
      }
    }
  }, [searchParams, rosters]);

  const teamA = rosters.find((r) => r.teamId === teamAId);
  const teamB = rosters.find((r) => r.teamId === teamBId);

  const getPlayerValue = (player: Player) => {
    if (personalValues[player.id]) return personalValues[player.id];
    return player.dynastyValue || DEFAULT_DYNASTY_VALUES[player.name] || 10;
  };

  const rosterName = (id: string) => rosters.find((r) => r.teamId === id)?.teamName || `Team ${id}`;

  // Whole-league context (contention windows, ranks, needs)
  const leagueContext = useMemo(() => {
    if (!leagueSettings || rosters.length === 0) return null;
    return buildLeagueContext(rosters, leagueSettings, personalValues);
  }, [rosters, leagueSettings, personalValues]);

  const teamACtx = teamAId ? leagueContext?.get(teamAId) ?? null : null;
  const teamBCtx = teamBId ? leagueContext?.get(teamBId) ?? null : null;

  // Filter available players
  const teamAAvailable = useMemo(() => {
    if (!teamA) return [];
    return teamA.players
      .filter((p) => !teamAPlayers.find((tp) => tp.id === p.id))
      .filter((p) => !searchA || p.name.toLowerCase().includes(searchA.toLowerCase()))
      .sort((a, b) => getPlayerValue(b) - getPlayerValue(a));
  }, [teamA, teamAPlayers, searchA, personalValues]);

  const teamBAvailable = useMemo(() => {
    if (!teamB) return [];
    return teamB.players
      .filter((p) => !teamBPlayers.find((tp) => tp.id === p.id))
      .filter((p) => !searchB || p.name.toLowerCase().includes(searchB.toLowerCase()))
      .sort((a, b) => getPlayerValue(b) - getPlayerValue(a));
  }, [teamB, teamBPlayers, searchB, personalValues]);

  const pickKey = (p: DraftPick) => `${p.year}-${p.round}-${p.originalOwner}`;

  const teamAPicksAvail = useMemo(() => {
    if (!teamA) return [];
    return teamA.draftPicks.filter((p) => !teamAPicks.find((tp) => pickKey(tp) === pickKey(p)));
  }, [teamA, teamAPicks]);

  const teamBPicksAvail = useMemo(() => {
    if (!teamB) return [];
    return teamB.draftPicks.filter((p) => !teamBPicks.find((tp) => pickKey(tp) === pickKey(p)));
  }, [teamB, teamBPicks]);

  // Smart trade analysis via engine
  const analysis = useMemo(() => {
    if (!teamACtx || !teamBCtx) return null;
    if (teamAPlayers.length === 0 && teamAPicks.length === 0 &&
        teamBPlayers.length === 0 && teamBPicks.length === 0) {
      return null;
    }
    return evaluateTrade({
      teamACtx,
      teamBCtx,
      aGivesPlayers: teamAPlayers,
      aGivesPicks: teamAPicks,
      bGivesPlayers: teamBPlayers,
      bGivesPicks: teamBPicks,
      personalValues,
    });
  }, [teamACtx, teamBCtx, teamAPlayers, teamAPicks, teamBPlayers, teamBPicks, personalValues]);

  function addPickToSide(side: "A" | "B", pick: DraftPick) {
    if (side === "A") setTeamAPicks([...teamAPicks, pick]);
    else setTeamBPicks([...teamBPicks, pick]);
  }

  function removePickFromSide(side: "A" | "B", index: number) {
    if (side === "A") setTeamAPicks(teamAPicks.filter((_, i) => i !== index));
    else setTeamBPicks(teamBPicks.filter((_, i) => i !== index));
  }

  function handleSaveTrade() {
    if (!analysis) return;
    const trade: SavedTrade = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      teamAId,
      teamAPlayers,
      teamAPickValues: teamAPicks.map((p) => p.estimatedValue),
      teamBId,
      teamBPlayers,
      teamBPickValues: teamBPicks.map((p) => p.estimatedValue),
      fairnessScore: analysis.marketFairness,
    };
    addSavedTrade(trade);
  }

  function handleReset() {
    setTeamAPlayers([]);
    setTeamBPlayers([]);
    setTeamAPicks([]);
    setTeamBPicks([]);
    setSearchA("");
    setSearchB("");
  }

  if (rosters.length === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight gradient-text">Trade Simulator</h1>
          <p className="text-muted-foreground mt-2 text-lg">Connect your league first to simulate trades</p>
        </div>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <ArrowRightLeft className="h-16 w-16 text-muted-foreground mb-6" />
            <h2 className="text-xl font-semibold mb-2">Connect Your League</h2>
            <p className="text-muted-foreground text-center max-w-md mb-6">
              Import your Sleeper league to start analyzing trades with your personal values.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight gradient-text">Trade Simulator</h1>
          <p className="text-muted-foreground mt-2 text-base sm:text-lg">
            Analyze trades with your personal values
          </p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <Button variant="outline" size="sm" onClick={handleReset} className="flex-1 sm:flex-none">
            <RotateCcw className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Reset</span>
          </Button>
          {analysis && (
            <Button size="sm" onClick={handleSaveTrade} className="flex-1 sm:flex-none">
              <Save className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Save Trade</span>
            </Button>
          )}
        </div>
      </div>

      {/* Smart Analysis */}
      {analysis && teamACtx && teamBCtx && (
        <Card className={cn(
          "modern-card border-l-4",
          analysis.verdictForA.tone === "good" && "border-l-green-500",
          analysis.verdictForA.tone === "fair" && "border-l-blue-500",
          analysis.verdictForA.tone === "bad" && "border-l-red-500",
        )}>
          <CardContent className="py-6 space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3 sm:gap-4">
                <Sparkles className={cn("h-6 w-6 sm:h-8 sm:w-8 shrink-0",
                  analysis.verdictForA.tone === "good" && "text-green-400",
                  analysis.verdictForA.tone === "fair" && "text-blue-400",
                  analysis.verdictForA.tone === "bad" && "text-red-400",
                )} />
                <div>
                  <p className={cn("font-bold text-lg sm:text-xl",
                    analysis.verdictForA.tone === "good" && "text-green-400",
                    analysis.verdictForA.tone === "fair" && "text-blue-400",
                    analysis.verdictForA.tone === "bad" && "text-red-400",
                  )}>{analysis.verdictForA.label}</p>
                  <p className="text-xs sm:text-sm text-muted-foreground">
                    From {rosterName(teamAId)}&apos;s perspective
                  </p>
                </div>
              </div>
              <div className="text-left sm:text-right w-full sm:w-auto">
                <p className="text-2xl sm:text-3xl font-bold font-mono">
                  {analysis.marketFairness >= 0 ? "+" : ""}{analysis.marketFairness.toFixed(0)}%
                </p>
                <p className="text-xs sm:text-sm text-muted-foreground">market value edge</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Market (give ↔ get)</p>
                <p className="text-lg font-medium font-mono">
                  {Math.round(analysis.marketA).toLocaleString()} ↔ {Math.round(analysis.marketB).toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Window Fit (You)</p>
                <p className={cn("text-lg font-medium", analysis.fitAPct >= 0 ? "text-green-400" : "text-red-400")}>
                  {analysis.fitAPct >= 0 ? "+" : ""}{analysis.fitAPct.toFixed(1)}%
                </p>
              </div>
              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{rosterName(teamBId)} accepts</p>
                <p className={cn("text-lg font-medium",
                  analysis.acceptanceLikelihood >= 60 ? "text-green-400" : analysis.acceptanceLikelihood <= 40 ? "text-red-400" : "text-yellow-400"
                )}>{analysis.acceptanceLikelihood.toFixed(0)}% likely</p>
              </div>
            </div>

            <div className="space-y-2">
              {analysis.reasoning.map((r, i) => (
                <div key={i} className="flex gap-2 text-sm text-muted-foreground">
                  <span className="text-primary mt-0.5">•</span>
                  <span dangerouslySetInnerHTML={{ __html: r.replace(/\*\*(.+?)\*\*/g, '<span class="text-foreground font-medium">$1</span>') }} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Trade Builder */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Team A Side */}
        <div className="space-y-4">
          <select
            value={teamAId}
            onChange={(e) => { setTeamAId(e.target.value); setTeamAPlayers([]); setTeamAPicks([]); }}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="">Select team giving...</option>
            {rosters.map((r) => (
              <option key={r.teamId} value={r.teamId}>
                {r.teamName || `Team ${r.teamId}`} {r.teamId === myTeamId ? "(You)" : ""}
              </option>
            ))}
          </select>

          {teamACtx && (
            <div className="flex items-center gap-2 text-sm">
              <span className={cn("font-semibold px-2 py-0.5 rounded", teamACtx.windowColor)}>{teamACtx.windowLabel}</span>
              <span className="text-muted-foreground">#{teamACtx.leagueRank} roster • avg age {teamACtx.avgAge.toFixed(1)}</span>
            </div>
          )}

          <Card className="modern-card h-full">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span>Giving Away</span>
                <span className="font-mono text-lg font-bold">
                  {(teamAPlayers.reduce((s, p) => s + getPlayerValue(p), 0) + teamAPicks.reduce((s, p) => s + p.estimatedValue, 0)).toLocaleString()}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {teamAPlayers.map((p) => (
                <div key={p.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted/70 transition-colors">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className={`text-xs w-10 justify-center ${positionColors[p.position] || ""}`}>
                      {p.position}
                    </Badge>
                    <div>
                      <span className="font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">{p.team}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono font-medium">
                      {getPlayerValue(p).toLocaleString()}
                    </span>
                    <button
                      onClick={() => setTeamAPlayers(teamAPlayers.filter((tp) => tp.id !== p.id))}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
              {teamAPicks.map((pick, i) => (
                <div key={pickKey(pick)} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted/70 transition-colors">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="text-xs w-10 justify-center">PICK</Badge>
                    <span className="font-medium">
                      {pickLabel(pick)}{pick.originalOwner !== pick.currentOwner ? ` (via ${rosterName(pick.originalOwner)})` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono font-medium">
                      {pick.estimatedValue.toLocaleString()}
                    </span>
                    <button
                      onClick={() => removePickFromSide("A", i)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}

              <Separator />

              <div className="space-y-3">
                <Select value="" onValueChange={(v) => {
                  const pick = teamAPicksAvail.find((p) => pickKey(p) === v);
                  if (pick) addPickToSide("A", pick);
                }}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="+ Add Draft Pick" />
                  </SelectTrigger>
                  <SelectContent>
                    {teamAPicksAvail.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">No picks available</div>
                    ) : teamAPicksAvail.map((pick) => (
                      <SelectItem key={pickKey(pick)} value={pickKey(pick)}>
                        {pickLabel(pick)}{pick.originalOwner !== pick.currentOwner ? ` (via ${rosterName(pick.originalOwner)})` : ""} ({pick.estimatedValue.toLocaleString()})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <input
                  type="text"
                  placeholder="Search players to add..."
                  value={searchA}
                  onChange={(e) => setSearchA(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <div className="space-y-1">
                  {teamAAvailable.slice(0, 20).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { setTeamAPlayers([...teamAPlayers, p]); setSearchA(""); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 rounded-lg flex items-center justify-between transition-colors"
                    >
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-xs w-10 justify-center ${positionColors[p.position] || ""}`}>
                          {p.position}
                        </Badge>
                        {p.name}
                      </span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {getPlayerValue(p).toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Team B Side */}
        <div className="space-y-4">
          <select
            value={teamBId}
            onChange={(e) => { setTeamBId(e.target.value); setTeamBPlayers([]); setTeamBPicks([]); }}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="">Select team receiving from...</option>
            {rosters.filter((r) => r.teamId !== teamAId).map((r) => (
              <option key={r.teamId} value={r.teamId}>
                {r.teamName || `Team ${r.teamId}`} {r.teamId === myTeamId ? "(You)" : ""}
              </option>
            ))}
          </select>

          {teamBCtx && (
            <div className="flex items-center gap-2 text-sm">
              <span className={cn("font-semibold px-2 py-0.5 rounded", teamBCtx.windowColor)}>{teamBCtx.windowLabel}</span>
              <span className="text-muted-foreground">#{teamBCtx.leagueRank} roster • avg age {teamBCtx.avgAge.toFixed(1)}</span>
            </div>
          )}

          <Card className="modern-card h-full">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span>Receiving</span>
                <span className="font-mono text-lg font-bold">
                  {(teamBPlayers.reduce((s, p) => s + getPlayerValue(p), 0) + teamBPicks.reduce((s, p) => s + p.estimatedValue, 0)).toLocaleString()}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {teamBPlayers.map((p) => (
                <div key={p.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted/70 transition-colors">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className={`text-xs w-10 justify-center ${positionColors[p.position] || ""}`}>
                      {p.position}
                    </Badge>
                    <div>
                      <span className="font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">{p.team}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono font-medium">
                      {getPlayerValue(p).toLocaleString()}
                    </span>
                    <button
                      onClick={() => setTeamBPlayers(teamBPlayers.filter((tp) => tp.id !== p.id))}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
              {teamBPicks.map((pick, i) => (
                <div key={pickKey(pick)} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted/70 transition-colors">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="text-xs w-10 justify-center">PICK</Badge>
                    <span className="font-medium">
                      {pickLabel(pick)}{pick.originalOwner !== pick.currentOwner ? ` (via ${rosterName(pick.originalOwner)})` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono font-medium">
                      {pick.estimatedValue.toLocaleString()}
                    </span>
                    <button
                      onClick={() => removePickFromSide("B", i)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}

              <Separator />

              <div className="space-y-3">
                <Select value="" onValueChange={(v) => {
                  const pick = teamBPicksAvail.find((p) => pickKey(p) === v);
                  if (pick) addPickToSide("B", pick);
                }}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="+ Add Draft Pick" />
                  </SelectTrigger>
                  <SelectContent>
                    {teamBPicksAvail.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">No picks available</div>
                    ) : teamBPicksAvail.map((pick) => (
                      <SelectItem key={pickKey(pick)} value={pickKey(pick)}>
                        {pickLabel(pick)}{pick.originalOwner !== pick.currentOwner ? ` (via ${rosterName(pick.originalOwner)})` : ""} ({pick.estimatedValue.toLocaleString()})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <input
                  type="text"
                  placeholder="Search players to add..."
                  value={searchB}
                  onChange={(e) => setSearchB(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <div className="space-y-1">
                  {teamBAvailable.slice(0, 20).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { setTeamBPlayers([...teamBPlayers, p]); setSearchB(""); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 rounded-lg flex items-center justify-between transition-colors"
                    >
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-xs w-10 justify-center ${positionColors[p.position] || ""}`}>
                          {p.position}
                        </Badge>
                        {p.name}
                      </span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {getPlayerValue(p).toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function TradePage() {
  return (
    <Suspense fallback={<div className="p-8">Loading trade simulator...</div>}>
      <TradePageContent />
    </Suspense>
  );
}
