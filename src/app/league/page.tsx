"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Activity,
  AlertCircle,
  ArrowLeftRight,
  ArrowRight,
  CalendarDays,
  Gauge,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Target,
  TrendingUp,
} from "lucide-react";
import type { SleeperLeague } from "@/types";
import { buildLeagueContext } from "@/lib/analytics";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

const SLOT_COLORS: Record<string, string> = {
  QB:    "bg-blue-500/15 text-blue-400 border-blue-500/20",
  RB:    "bg-green-500/15 text-green-400 border-green-500/20",
  WR:    "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  TE:    "bg-orange-500/15 text-orange-400 border-orange-500/20",
  FLEX:  "bg-purple-500/15 text-purple-400 border-purple-500/20",
  SUPERFLEX: "bg-sky-500/15 text-sky-400 border-sky-500/20",
  K:     "bg-gray-500/15 text-gray-400 border-gray-500/20",
  DEF:   "bg-gray-500/15 text-gray-400 border-gray-500/20",
  BN:    "bg-muted text-muted-foreground border-border",
};

const POSITIONS = ["QB", "RB", "WR", "TE"] as const;

const WINDOW_STRATEGY: Record<string, string> = {
  "Win Now": "Your window is open. Prioritize proven starters and accept some future-value cost when the lineup gain is meaningful.",
  Competing: "Add reliable production without emptying your future assets. Consolidation trades are your best path forward.",
  Balanced: "Stay flexible. Target prime-age players who improve today without shortening your competitive timeline.",
  "Young Core": "Protect cornerstone players and add assets that can appreciate alongside your core.",
  Rebuilding: "Turn aging production into youth and draft capital. Avoid paying for short-term points before the roster is ready.",
};

export default function LeaguePage() {
  const {
    leagueSettings,
    rosters,
    myTeamId,
    personalValues,
    setLeagueSettings,
    setRosters,
    setMyTeamId,
    setPlayers,
    setTradeAnalysis,
    dataFreshness,
    setDataFreshness,
    sleeperUsername,
    sleeperLeagueId,
    setSleeperConnection,
    clearAllData,
  } = useAppStore();

  const dashboard = useMemo(() => {
    if (!leagueSettings || !myTeamId || rosters.length === 0) return null;
    const context = buildLeagueContext(rosters, leagueSettings, personalValues).get(myTeamId);
    const roster = rosters.find((team) => team.teamId === myTeamId);
    if (!context || !roster) return null;

    const positions = POSITIONS.map((position) => ({
      position,
      rank: context.relativePositionRanks[position] ?? rosters.length,
      need: Math.round(context.positionNeeds[position] ?? 0),
    })).sort((a, b) => b.need - a.need || b.rank - a.rank);

    const weakest = positions[0];
    const strongest = [...positions].sort((a, b) => a.rank - b.rank)[0];
    const deadZonePlayers = context.deadZonePlayerIds
      .map((id) => roster.players.find((player) => player.id === id))
      .filter((player): player is NonNullable<typeof player> => Boolean(player));

    const actions = [
      {
        title: `Explore ${weakest.position} upgrades`,
        detail: `Your ${weakest.position} room ranks #${weakest.rank} of ${context.totalTeams} with a ${weakest.need}% need score.`,
        href: `/recommendations?position=${weakest.position}`,
        label: "Find targets",
      },
      deadZonePlayers[0]
        ? {
            title: `Test the market for ${deadZonePlayers[0].name}`,
            detail: `${deadZonePlayers[0].name} is entering the value-decline zone while still carrying useful trade value.`,
            href: "/trade",
            label: "Build a trade",
          }
        : {
            title: `Build around your ${strongest.position} advantage`,
            detail: `Your ${strongest.position} group ranks #${strongest.rank}. Use surplus depth to address weaker positions.`,
            href: "/trade",
            label: "Open simulator",
          },
      {
        title: context.pickSurplusLabel === "deficit" ? "Protect your remaining picks" : "Put your draft capital to work",
        detail: context.pickSurplusLabel === "deficit"
          ? "Your pick capital trails the league baseline. Avoid attaching picks to lateral moves."
          : `You hold ${context.pickCount} picks worth ${Math.round(context.pickCapital)} value points. Match them to your competitive window.`,
        href: "/draft",
        label: "Review picks",
      },
    ];

    return { context, roster, positions, actions };
  }, [leagueSettings, myTeamId, personalValues, rosters]);

  const [username, setUsername] = useState(sleeperUsername || "");
  const usernameRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leagues, setLeagues] = useState<Array<SleeperLeague & { season: string }>>([]);
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
    } catch (error: unknown) {
      setError(errorMessage(error));
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
      if (data.freshness) setDataFreshness(data.freshness);
      setSleeperConnection(username.trim(), leagueId);
      setStep("done");
    } catch (error: unknown) {
      setError(errorMessage(error));
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
        <h1 className="text-3xl font-bold tracking-tight">{step === "done" ? "League Hub" : "League Setup"}</h1>
        <p className="text-muted-foreground mt-1">
          {step === "done"
            ? "Understand your roster, competitive window, and best next move"
            : "Connect your Sleeper league to import rosters and settings"}
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
              {dataFreshness && (
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>League refreshed {new Date(dataFreshness.leagueImportedAt).toLocaleString()}</span>
                  <span>·</span>
                  <span className={dataFreshness.fantasyCalcStatus === "live" ? "text-green-500" : "text-yellow-500"}>
                    Values: {dataFreshness.fantasyCalcStatus === "live"
                      ? `FantasyCalc ${dataFreshness.fantasyCalcFetchedAt ? new Date(dataFreshness.fantasyCalcFetchedAt).toLocaleString() : "current"}`
                      : "fallback database"}
                  </span>
                </div>
              )}
            </div>
              <div className="flex items-center gap-1.5 shrink-0 mt-1">
              <span className="px-2 py-0.5 rounded text-xs font-semibold bg-violet-500/15 text-violet-400 border border-violet-500/20 capitalize">
                {leagueSettings.mode}
              </span>
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

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Refresh failed</p>
                <p className="mt-0.5 text-xs opacity-90">{error} Your previously imported league data is still available.</p>
              </div>
            </div>
          )}

          {dashboard && (
            <div className="space-y-5">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  Your {leagueSettings.mode === "redraft" ? "Redraft" : "Dynasty"} Dashboard
                </p>
                <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h3 className="text-xl font-bold">{dashboard.roster.teamName}</h3>
                    <p className="text-sm text-muted-foreground">A league-relative view of where your roster stands and what to do next.</p>
                  </div>
                  <span className={`text-sm font-semibold ${dashboard.context.windowColor}`}>
                    {dashboard.context.windowLabel}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card className="modern-card">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="text-xs uppercase tracking-wide">Lineup rank</span>
                      <TrendingUp className="h-4 w-4" />
                    </div>
                    <p className="mt-2 text-2xl font-bold">#{dashboard.context.leagueRank}</p>
                    <p className="text-xs text-muted-foreground">of {dashboard.context.totalTeams} teams</p>
                  </CardContent>
                </Card>
                <Card className="modern-card">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="text-xs uppercase tracking-wide">
                        {leagueSettings.mode === "redraft" ? "Roster score" : "Dynasty score"}
                      </span>
                      <Gauge className="h-4 w-4" />
                    </div>
                    <p className="mt-2 text-2xl font-bold">{dashboard.context.dynastyPowerScore}<span className="text-sm text-muted-foreground">/100</span></p>
                    <p className="text-xs text-muted-foreground">
                      {leagueSettings.mode === "redraft" ? "current-season outlook" : "current + future outlook"}
                    </p>
                  </CardContent>
                </Card>
                <Card className="modern-card">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="text-xs uppercase tracking-wide">Core age</span>
                      <Activity className="h-4 w-4" />
                    </div>
                    <p className="mt-2 text-2xl font-bold">{dashboard.context.avgAge.toFixed(1)}</p>
                    <p className="text-xs text-muted-foreground">value-weighted age</p>
                  </CardContent>
                </Card>
                <Card className="modern-card">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="text-xs uppercase tracking-wide">
                        {leagueSettings.mode === "redraft" ? "Roster size" : "Draft capital"}
                      </span>
                      <CalendarDays className="h-4 w-4" />
                    </div>
                    <p className="mt-2 text-2xl font-bold">
                      {leagueSettings.mode === "redraft" ? dashboard.roster.players.length : dashboard.context.pickCount}
                    </p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {leagueSettings.mode === "redraft" ? "active players" : `${dashboard.context.pickSurplusLabel} supply`}
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card className="modern-card">
                <CardContent className="p-5">
                  <div className="flex gap-3">
                    <ShieldCheck className={`mt-0.5 h-5 w-5 shrink-0 ${dashboard.context.windowColor}`} />
                    <div>
                      <p className="font-semibold">{dashboard.context.windowLabel} strategy</p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {WINDOW_STRATEGY[dashboard.context.windowLabel]}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="modern-card">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Position health</CardTitle>
                    <p className="text-xs text-muted-foreground">Need combines depth, starter quality, and league format.</p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {dashboard.positions.map(({ position, rank, need }) => (
                      <div key={position}>
                        <div className="mb-1.5 flex items-center justify-between text-sm">
                          <span className="font-semibold">{position}</span>
                          <span className="text-xs text-muted-foreground">#{rank} of {dashboard.context.totalTeams} · {need}% need</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${need >= 55 ? "bg-red-500" : need >= 30 ? "bg-yellow-500" : "bg-green-500"}`}
                            style={{ width: `${Math.max(4, need)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card className="modern-card">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base"><Target className="h-4 w-4" /> Next moves</CardTitle>
                    <p className="text-xs text-muted-foreground">Actions based on your roster window and league position.</p>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {dashboard.actions.map((action, index) => (
                      <Link
                        key={action.title}
                        href={action.href}
                        className="group flex gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary/40 hover:bg-muted/40"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">{index + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold">{action.title}</span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{action.detail}</span>
                          <span className="mt-2 flex items-center gap-1 text-xs font-medium text-primary">
                            {action.label}<ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                          </span>
                        </span>
                      </Link>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {dashboard && <div className="h-px bg-border" />}

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
                leagues.map((league) => {
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
