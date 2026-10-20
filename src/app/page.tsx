"use client";

import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRightLeft, Users, TrendingUp, Settings, Crown, Zap, Trophy, ArrowRight } from "lucide-react";
import Link from "next/link";
import { DEFAULT_DYNASTY_VALUES } from "@/lib/player-values";
import { useCallback, useMemo } from "react";

export default function Home() {
  const { leagueSettings, rosters, myTeamId, personalValues } = useAppStore();

  const myRoster = rosters.find((r) => r.teamId === myTeamId);

  const getPlayerValue = useCallback((player: { id: string; name: string; dynastyValue: number }) => {
    if (personalValues[player.id] !== undefined) return personalValues[player.id];
    return player.dynastyValue || DEFAULT_DYNASTY_VALUES[player.name] || 0;
  }, [personalValues]);

  const getRosterValue = useCallback((roster: typeof rosters[0]) => {
    return roster.players.reduce((sum, p) => sum + getPlayerValue(p), 0);
  }, [getPlayerValue]);

  const getAverageAge = useCallback((roster: typeof rosters[0]) => {
    const ages = roster.players.filter((p) => p.age > 0).map((p) => p.age);
    if (ages.length === 0) return 0;
    return ages.reduce((sum, age) => sum + age, 0) / ages.length;
  }, []);

  const { myRank, myValue, myAvgAge, topPlayers } = useMemo(() => {
    if (!myRoster || rosters.length === 0) {
      return { myRank: 0, myValue: 0, myAvgAge: 0, topPlayers: [] };
    }

    const sortedRosters = [...rosters].sort((a, b) => getRosterValue(b) - getRosterValue(a));
    const myRank = sortedRosters.findIndex((r) => r.teamId === myTeamId) + 1;
    const myValue = getRosterValue(myRoster);
    const myAvgAge = getAverageAge(myRoster);
    const topPlayers = [...myRoster.players]
      .sort((a, b) => getPlayerValue(b) - getPlayerValue(a))
      .slice(0, 5);

    return { myRank, myValue, myAvgAge, topPlayers };
  }, [myRoster, rosters, myTeamId, getAverageAge, getPlayerValue, getRosterValue]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight gradient-text">Dashboard</h1>
        <p className="text-muted-foreground mt-2 text-base sm:text-lg">
          {leagueSettings
            ? `${leagueSettings.mode === "redraft" ? "Redraft" : leagueSettings.mode === "keeper" ? "Keeper" : "Dynasty"} trade simulator & recommendation engine`
            : "Trade intelligence for dynasty and redraft leagues"}
        </p>
      </div>

      {!leagueSettings ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Settings className="h-16 w-16 text-muted-foreground mb-6" />
            <h2 className="text-2xl font-semibold mb-3">Connect Your League</h2>
            <p className="text-muted-foreground text-center max-w-md mb-6">
              Import your Sleeper league to get started with personalized trade
              analysis and recommendations.
            </p>
            <Link href="/league">
              <Button size="lg">
                Set Up League
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* My Team Stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="modern-card">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">League Rank</CardTitle>
                <Crown className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">#{myRank}</div>
                <p className="text-xs text-muted-foreground">of {rosters.length} teams</p>
              </CardContent>
            </Card>

            <Card className="modern-card">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Avg Age</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{myAvgAge > 0 ? myAvgAge.toFixed(1) : "—"}</div>
                <p className="text-xs text-muted-foreground">Roster average</p>
              </CardContent>
            </Card>

            <Card className="modern-card">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Team Value</CardTitle>
                <Trophy className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold font-mono">{myValue.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground">
                  Total {leagueSettings.mode === "redraft" ? "rest-of-season" : "dynasty"} value
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Players */}
            <Card className="modern-card">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Zap className="h-5 w-5" />
                  Top Players
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {topPlayers.map((player, idx) => (
                    <div
                      key={player.id}
                      className="flex items-center justify-between py-2 px-3 rounded-lg bg-muted/50"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-muted-foreground w-4">#{idx + 1}</span>
                        <div>
                          <p className="font-medium">{player.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {player.position} • {player.team} {player.age > 0 && `• ${player.age}y`}
                          </p>
                        </div>
                      </div>
                      <span className="text-sm font-mono font-bold">
                        {getPlayerValue(player).toLocaleString()}
                      </span>
                    </div>
                  ))}
                  {topPlayers.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">No players on roster</p>
                  )}
                </div>
                <Link href={`/rosters/${myTeamId}`}>
                  <Button variant="ghost" size="sm" className="w-full mt-4">
                    View Full Roster
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </Link>
              </CardContent>
            </Card>

            {/* Quick Actions */}
            <div className="flex flex-col gap-5">
              <Link href="/trade">
                <Card className="modern-card hover:border-primary/50 transition-all cursor-pointer group">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <ArrowRightLeft className="h-4 w-4 text-primary" />
                      Trade Simulator
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      Analyze trades with your personal player values and league context. Get fairness scores and recommendations.
                    </p>
                    <div className="flex items-center text-sm text-primary mt-3 group-hover:underline">
                      Open Simulator
                      <ArrowRight className="h-4 w-4 ml-1" />
                    </div>
                  </CardContent>
                </Card>
              </Link>

              <Link href="/recommendations">
                <Card className="modern-card hover:border-primary/50 transition-all cursor-pointer group">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <TrendingUp className="h-4 w-4 text-primary" />
                      Trade Finder
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      Get AI-powered trade suggestions based on your roster needs, league-mate tendencies, and value gaps.
                    </p>
                    <div className="flex items-center text-sm text-primary mt-3 group-hover:underline">
                      Find Trades
                      <ArrowRight className="h-4 w-4 ml-1" />
                    </div>
                  </CardContent>
                </Card>
              </Link>

              <Link href="/rosters">
                <Card className="modern-card hover:border-primary/50 transition-all cursor-pointer group">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Users className="h-4 w-4 text-primary" />
                      All Rosters
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      View all teams in your league with their dynasty values and positional breakdowns.
                    </p>
                    <div className="flex items-center text-sm text-primary mt-3 group-hover:underline">
                      View Rosters
                      <ArrowRight className="h-4 w-4 ml-1" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
