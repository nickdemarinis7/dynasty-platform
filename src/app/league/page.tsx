"use client";

import { useState, useRef } from "react";
import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CheckCircle2, Loader2, AlertCircle, Wifi, RefreshCw, LogOut, ArrowLeftRight } from "lucide-react";

const SLOT_COLORS: Record<string, string> = {
  QB:    "bg-blue-500/15 text-blue-400 border-blue-500/20",
  RB:    "bg-green-500/15 text-green-400 border-green-500/20",
  WR:    "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  TE:    "bg-orange-500/15 text-orange-400 border-orange-500/20",
  FLEX:  "bg-purple-500/15 text-purple-400 border-purple-500/20",
  SUPER_FLEX: "bg-sky-500/15 text-sky-400 border-sky-500/20",
  K:     "bg-gray-500/15 text-gray-400 border-gray-500/20",
  DEF:   "bg-gray-500/15 text-gray-400 border-gray-500/20",
  BN:    "bg-muted text-muted-foreground border-border",
};

export default function LeaguePage() {
  const {
    leagueSettings,
    setLeagueSettings,
    setRosters,
    setMyTeamId,
    setPlayers,
    setTradeAnalysis,
    sleeperUsername,
    sleeperLeagueId,
    setSleeperConnection,
    clearAllData,
  } = useAppStore();

  const [username, setUsername] = useState(sleeperUsername || "");
  const usernameRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leagues, setLeagues] = useState<any[]>([]);
  const [step, setStep] = useState<"username" | "select_league" | "done">(
    leagueSettings ? "done" : "username"
  );

  async function handleFetchLeagues() {
    const inputVal = usernameRef.current?.value || username;
    if (!inputVal.trim()) {
      setError("Please enter a username");
      return;
    }
    setUsername(inputVal.trim());
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/sleeper/leagues?username=${encodeURIComponent(inputVal.trim())}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to fetch leagues");
      }
      const data = await res.json();
      setLeagues(data.leagues);
      setStep("select_league");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectLeague(leagueId: string) {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/sleeper/import?leagueId=${leagueId}&username=${encodeURIComponent(username.trim())}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to import league");
      }
      const data = await res.json();

      setLeagueSettings(data.leagueSettings);
      setRosters(data.rosters);
      setMyTeamId(data.myTeamId);
      setPlayers(data.players);
      setTradeAnalysis(data.tradeAnalysis || null);
      setSleeperConnection(username.trim(), leagueId);
      setStep("done");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    if (!sleeperLeagueId || !sleeperUsername) return;
    await handleSelectLeague(sleeperLeagueId);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">League Setup</h1>
        <p className="text-muted-foreground mt-1">
          Connect your Sleeper league to import rosters and settings
        </p>
      </div>

      {/* ── Connected state ────────────────────────────────── */}
      {step === "done" && leagueSettings && (
        <div className="space-y-5">
          {/* League identity */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
                <span className="text-xs text-green-500 font-medium">Connected</span>
              </div>
              <h2 className="text-2xl font-bold">{leagueSettings.name}</h2>
              <div className="flex items-center gap-2 mt-1.5 text-sm text-muted-foreground flex-wrap">
                <span>{leagueSettings.teamCount} teams</span>
                <span>·</span>
                <span className="capitalize">{leagueSettings.platform}</span>
                <span>·</span>
                <span>{leagueSettings.superflex ? "Superflex" : "1QB"}</span>
                <span>·</span>
                <span>{leagueSettings.scoringType.replace(/_/g, " ")}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 mt-1">
              {leagueSettings.superflex && (
                <span className="px-2 py-0.5 rounded text-xs font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/20">SF</span>
              )}
              {leagueSettings.tePremium && (
                <span className="px-2 py-0.5 rounded text-xs font-semibold bg-orange-500/15 text-orange-400 border border-orange-500/20">TEP</span>
              )}
              <span className="px-2 py-0.5 rounded text-xs font-semibold bg-primary/15 text-primary border border-primary/20">
                {leagueSettings.scoringType.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="h-px bg-border" />

          {/* Roster construction */}
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2.5">Roster Construction</p>
            <div className="flex flex-wrap gap-1.5">
              {leagueSettings.rosterSlots.map((slot, i) => {
                const colorClass = SLOT_COLORS[slot.type] ?? SLOT_COLORS.BN;
                return (
                  <span key={i} className={`px-2.5 py-1 rounded text-xs font-semibold border ${colorClass}`}>
                    {slot.count > 1 ? `${slot.count}× ` : ""}{slot.type}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="h-px bg-border" />

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading} className="gap-2">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground"
              onClick={() => { setStep("username"); setLeagues([]); }}>
              <ArrowLeftRight className="h-3.5 w-3.5" />
              Change League
            </Button>
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground ml-auto"
              onClick={() => { clearAllData(); setStep("username"); setLeagues([]); }}>
              <LogOut className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          </div>
        </div>
      )}

      {/* ── Username step ──────────────────────────────────── */}
      {step === "username" && (
        <div className="max-w-lg">
          <Card className="modern-card">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Connect Sleeper Account</CardTitle>
              <p className="text-sm text-muted-foreground">Enter your Sleeper username to find your dynasty leagues.</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-sm font-medium">Sleeper Username</Label>
                <div className="flex gap-2">
                  <Input
                    id="username"
                    ref={usernameRef}
                    placeholder="e.g. nickdemarinis"
                    defaultValue={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); handleFetchLeagues(); }
                    }}
                    className="flex-1"
                  />
                  <Button type="button" disabled={loading} onClick={() => handleFetchLeagues()} className="shrink-0">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Find Leagues"}
                  </Button>
                </div>
              </div>
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {error}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── League picker ──────────────────────────────────── */}
      {step === "select_league" && (
        <div className="max-w-2xl">
          <Card className="modern-card">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Select Your League</CardTitle>
              <p className="text-sm text-muted-foreground">
                Found {leagues.length} league{leagues.length !== 1 ? "s" : ""} for <span className="font-medium text-foreground">{username}</span>
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {leagues.length === 0 ? (
                <p className="text-muted-foreground text-sm py-4 text-center">No leagues found for this username.</p>
              ) : (
                leagues.map((league: any) => {
                  const leagueType = league.settings?.type === 2 ? "Dynasty" : league.settings?.type === 1 ? "Keeper" : "Redraft";
                  const isDynasty = league.settings?.type === 2;
                  const isSF = league.roster_positions?.includes("SUPER_FLEX");
                  return (
                    <button
                      key={league.league_id}
                      onClick={() => handleSelectLeague(league.league_id)}
                      disabled={loading}
                      className="w-full text-left px-4 py-3.5 rounded-lg border border-border hover:border-primary/40 hover:bg-muted/40 transition-all disabled:opacity-50"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold truncate">{league.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {league.season} · {league.total_rosters} teams · {isSF ? "SF" : "1QB"}
                          </p>
                        </div>
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold shrink-0 ${isDynasty ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                          {leagueType}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm mt-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {error}
                </div>
              )}
              <div className="pt-2">
                <Button variant="ghost" size="sm" onClick={() => setStep("username")} className="text-muted-foreground">
                  ← Back
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
