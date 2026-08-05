"use client";

import { useState, useMemo } from "react";
import { useAppStore } from "@/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Trash2, Clock, TrendingUp, Filter, Target, Shield, AlertTriangle, Trophy, Award, TrendingDown, Calendar, ArrowUpDown, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

type FilterType = "all" | "my-team" | "league";
type SortKey = "date" | "fairness" | "value";

export default function TradeHistoryPage() {
  const { savedTrades, removeSavedTrade, rosters, tradeAnalysis, myTeamId } = useAppStore();
  const [filter, setFilter] = useState<FilterType>("all");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDesc, setSortDesc] = useState(true);

  function getTeamName(id: string) {
    return rosters.find((r) => r.teamId === id)?.teamName || `Team ${id}`;
  }

  function formatDate(timestamp: number) {
    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function getRecommendationLabel(score: number) {
    if (score > 20) return { label: "Strong Decline", color: "text-red-400 bg-red-500/10 border-red-500/30" };
    if (score > 8) return { label: "Slight Decline", color: "text-orange-400 bg-orange-500/10 border-orange-500/30" };
    if (score > -8) return { label: "Fair", color: "text-green-400 bg-green-500/10 border-green-500/30" };
    if (score > -20) return { label: "Slight Accept", color: "text-blue-400 bg-blue-500/10 border-blue-500/30" };
    return { label: "Strong Accept", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" };
  }

  // Filter and sort saved trades
  const filteredTrades = useMemo(() => {
    let trades = savedTrades.filter((trade) => {
      if (filter === "all") return true;
      if (filter === "my-team") return trade.teamAId === myTeamId || trade.teamBId === myTeamId;
      if (filter === "league") return true;
      return true;
    });

    // Sort trades
    trades = [...trades].sort((a, b) => {
      let comparison = 0;
      if (sortKey === "date") {
        comparison = a.timestamp - b.timestamp;
      } else if (sortKey === "fairness") {
        comparison = Math.abs(a.fairnessScore) - Math.abs(b.fairnessScore);
      } else if (sortKey === "value") {
        const aTotal = a.teamAPlayers.reduce((sum, p) => sum + (p.dynastyValue || 0), 0) + a.teamAPickValues.reduce((sum, v) => sum + v, 0);
        const bTotal = b.teamBPlayers.reduce((sum, p) => sum + (p.dynastyValue || 0), 0) + b.teamBPickValues.reduce((sum, v) => sum + v, 0);
        comparison = (aTotal + bTotal) - (aTotal + bTotal);
      }
      return sortDesc ? -comparison : comparison;
    });

    return trades;
  }, [savedTrades, filter, sortKey, sortDesc, myTeamId]);

  // Calculate trade record for my team
  const myTradeRecord = useMemo(() => {
    const myTrades = savedTrades.filter((trade) => 
      trade.teamAId === myTeamId || trade.teamBId === myTeamId
    );
    const wins = myTrades.filter((trade) => {
      const isTeamA = trade.teamAId === myTeamId;
      return isTeamA ? trade.fairnessScore < 0 : trade.fairnessScore > 0;
    }).length;
    const losses = myTrades.filter((trade) => {
      const isTeamA = trade.teamAId === myTeamId;
      return isTeamA ? trade.fairnessScore > 0 : trade.fairnessScore < 0;
    }).length;
    const ties = myTrades.length - wins - losses;
    return { wins, losses, ties, total: myTrades.length };
  }, [savedTrades, myTeamId]);

  // Find most susceptible teams (teams that tend to accept trades with negative value for them)
  const susceptibleTeams = useMemo(() => {
    if (!tradeAnalysis) return [];
    return Object.values(tradeAnalysis.teamStyles)
      .filter((style) => style.totalTrades >= 2)
      .sort((a, b) => b.totalTrades - a.totalTrades)
      .slice(0, 3);
  }, [tradeAnalysis]);

  // Best and worst trades
  const bestWorstTrades = useMemo(() => {
    const myTrades = savedTrades.filter((trade) => 
      trade.teamAId === myTeamId || trade.teamBId === myTeamId
    );
    
    const tradesWithScore = myTrades.map((trade) => {
      const isTeamA = trade.teamAId === myTeamId;
      const myScore = isTeamA ? -trade.fairnessScore : trade.fairnessScore;
      return { trade, myScore };
    });

    const sorted = [...tradesWithScore].sort((a, b) => b.myScore - a.myScore);
    return {
      best: sorted[0],
      worst: sorted[sorted.length - 1]
    };
  }, [savedTrades, myTeamId]);

  // Trade frequency stats
  const tradeFrequency = useMemo(() => {
    if (savedTrades.length < 2) return null;
    const timestamps = savedTrades.map(t => t.timestamp).sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }
    const avgInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
    const avgDays = Math.round(avgInterval / (1000 * 60 * 60 * 24));
    return avgDays;
  }, [savedTrades]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc(!sortDesc);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  function getTimeSince(timestamp: number) {
    const now = Date.now();
    const diff = now - timestamp;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight gradient-text">Trade History</h1>
        <p className="text-muted-foreground mt-2 text-base sm:text-lg">
          Historical trade analysis, patterns, and saved trades
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 sm:gap-6 text-xs sm:text-sm">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500"></div>
            <span className="text-muted-foreground"><span className="font-semibold text-foreground">Win</span> = Got better value</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-500"></div>
            <span className="text-muted-foreground"><span className="font-semibold text-foreground">Loss</span> = Gave up more value</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gray-500"></div>
            <span className="text-muted-foreground"><span className="font-semibold text-foreground">Fair</span> = Even value</span>
          </div>
        </div>
      </div>

      {/* Trade Record for My Team */}
      {myTeamId && myTradeRecord.total > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="modern-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="h-5 w-5" />
                My Trade Record
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-4">
                <div className="text-center">
                  <p className="text-3xl font-black font-mono text-green-400">{myTradeRecord.wins}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Wins</p>
                </div>
                <div className="text-center">
                  <p className="text-3xl font-black font-mono text-red-400">{myTradeRecord.losses}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Losses</p>
                </div>
                <div className="text-center">
                  <p className="text-3xl font-black font-mono text-muted-foreground">{myTradeRecord.ties}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Fair</p>
                </div>
                <div className="text-center">
                  <p className="text-3xl font-black font-mono">{myTradeRecord.total}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total</p>
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-border/50">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Win Rate</span>
                  <span className={cn(
                    "font-bold font-mono",
                    myTradeRecord.wins / myTradeRecord.total >= 0.6 ? "text-green-400" :
                    myTradeRecord.wins / myTradeRecord.total >= 0.4 ? "text-yellow-400" : "text-red-400"
                  )}>
                    {((myTradeRecord.wins / myTradeRecord.total) * 100).toFixed(0)}%
                  </span>
                </div>
                {tradeFrequency && (
                  <div className="flex items-center justify-between text-sm mt-2">
                    <span className="text-muted-foreground">Avg Time Between Trades</span>
                    <span className="font-mono text-foreground">{tradeFrequency}d</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Best/Worst Trades */}
          {bestWorstTrades.best && bestWorstTrades.worst && (
            <Card className="modern-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-5 w-5" />
                  Trade Highlights
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                  <div className="flex items-center gap-2 mb-2">
                    <Trophy className="h-4 w-4 text-green-400" />
                    <span className="text-xs font-semibold text-green-400 uppercase tracking-wide">Best Trade</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getTimeSince(bestWorstTrades.best.trade.timestamp)}</span>
                  </div>
                  <div className="text-xs space-y-1">
                    {bestWorstTrades.best.trade.teamAId === myTeamId ? (
                      <>
                        <div className="text-muted-foreground">Acquired: {bestWorstTrades.best.trade.teamBPlayers.map(p => p.name).join(", ") || "Picks"}</div>
                        <div className="text-green-400 font-semibold">+{Math.abs(bestWorstTrades.best.myScore).toFixed(0)} value advantage</div>
                      </>
                    ) : (
                      <>
                        <div className="text-muted-foreground">Acquired: {bestWorstTrades.best.trade.teamAPlayers.map(p => p.name).join(", ") || "Picks"}</div>
                        <div className="text-green-400 font-semibold">+{Math.abs(bestWorstTrades.best.myScore).toFixed(0)} value advantage</div>
                      </>
                    )}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                  <div className="flex items-center gap-2 mb-2">
                    <TrendingDown className="h-4 w-4 text-red-400" />
                    <span className="text-xs font-semibold text-red-400 uppercase tracking-wide">Worst Trade</span>
                    <span className="ml-auto text-xs text-muted-foreground">{getTimeSince(bestWorstTrades.worst.trade.timestamp)}</span>
                  </div>
                  <div className="text-xs space-y-1">
                    {bestWorstTrades.worst.trade.teamAId === myTeamId ? (
                      <>
                        <div className="text-muted-foreground">Gave up: {bestWorstTrades.worst.trade.teamAPlayers.map(p => p.name).join(", ") || "Picks"}</div>
                        <div className="text-red-400 font-semibold">{Math.abs(bestWorstTrades.worst.myScore).toFixed(0)} value disadvantage</div>
                      </>
                    ) : (
                      <>
                        <div className="text-muted-foreground">Gave up: {bestWorstTrades.worst.trade.teamBPlayers.map(p => p.name).join(", ") || "Picks"}</div>
                        <div className="text-red-400 font-semibold">{Math.abs(bestWorstTrades.worst.myScore).toFixed(0)} value disadvantage</div>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Team Trading Susceptibilities */}
      {tradeAnalysis && susceptibleTeams.length > 0 && (
        <Card className="modern-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="h-5 w-5" />
              Team Trading Susceptibilities
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Teams most likely to accept trades based on historical patterns
            </p>
            <div className="space-y-3">
              {susceptibleTeams.map((style) => (
                <div key={style.teamId} className="p-3 rounded-lg bg-muted/50 border border-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">{style.teamName}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-green-400">{style.wins}W</span>
                      <span className="text-xs text-red-400">{style.losses}L</span>
                      {style.ties > 0 && <span className="text-xs text-muted-foreground">{style.ties}T</span>}
                      <Badge variant="outline" className="text-xs">
                        {style.totalTrades} trades
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Prefers acquiring:</span>
                    {style.preferredPositionsToAcquire.length > 0 ? (
                      style.preferredPositionsToAcquire.map((pos, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">
                          {pos}
                        </Badge>
                      ))
                    ) : (
                      <span>N/A</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Historical Trade Analysis */}
      {tradeAnalysis && (
        <Card className="modern-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Historical Trade Patterns
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium mb-2">Most Common Trade Types</p>
              <div className="space-y-2">
                {tradeAnalysis.patterns.length > 0 ? (
                  tradeAnalysis.patterns.slice(0, 5).map((pattern, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm p-2 rounded bg-muted/30">
                      <Badge variant="outline">{pattern.positionSwap}</Badge>
                      <span className="text-muted-foreground">
                        {pattern.count} trades
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No trade patterns found yet</p>
                )}
              </div>
            </div>
            <Separator />
            <div>
              <p className="text-sm font-medium mb-2">Average Value Difference for Accepted Trades</p>
              <p className="text-lg font-mono">{tradeAnalysis.avgValueDiffForAcceptedTrades.toFixed(1)}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Saved Trades Section */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xl font-semibold">Saved Trades ({filteredTrades.length})</h2>
        <div className="flex gap-2 flex-wrap">
          <div className="flex gap-1 border border-border rounded-lg p-1">
            <button
              onClick={() => setFilter("all")}
              className={cn(
                "px-3 py-1.5 rounded text-xs font-medium transition-colors",
                filter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              All
            </button>
            <button
              onClick={() => setFilter("my-team")}
              className={cn(
                "px-3 py-1.5 rounded text-xs font-medium transition-colors",
                filter === "my-team" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              My Team
            </button>
          </div>
          <div className="flex gap-1 border border-border rounded-lg p-1">
            <button
              onClick={() => toggleSort("date")}
              className={cn(
                "px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1",
                sortKey === "date" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Calendar className="h-3 w-3" />
              Date {sortKey === "date" && (sortDesc ? "↓" : "↑")}
            </button>
            <button
              onClick={() => toggleSort("fairness")}
              className={cn(
                "px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1",
                sortKey === "fairness" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <ArrowUpDown className="h-3 w-3" />
              Fairness {sortKey === "fairness" && (sortDesc ? "↓" : "↑")}
            </button>
          </div>
        </div>
      </div>

      {filteredTrades.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Clock className="h-16 w-16 text-muted-foreground mb-6" />
            <h2 className="text-xl font-semibold mb-2">No Saved Trades</h2>
            <p className="text-muted-foreground text-center max-w-md">
              {savedTrades.length === 0 
                ? "Analyze trades in the Trade Simulator and save them here."
                : "No trades match the current filter. Try changing the filter to see more trades."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredTrades.map((trade) => {
            const rec = getRecommendationLabel(trade.fairnessScore);
            return (
              <Card key={trade.id} className="modern-card">
                <CardContent className="py-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 space-y-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <Badge variant="outline" className={cn(rec.color, "font-semibold")}>
                          {rec.label}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(trade.timestamp)}
                        </span>
                        <span className="text-xs text-muted-foreground/70">
                          • {getTimeSince(trade.timestamp)}
                        </span>
                        {(trade.teamAId === myTeamId || trade.teamBId === myTeamId) && (
                          <Badge variant="secondary" className="text-xs">
                            My Trade
                          </Badge>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-sm text-muted-foreground mb-2">
                            {getTeamName(trade.teamAId)} gives:
                          </p>
                          <div className="space-y-1">
                            {trade.teamAPlayers.map((p) => (
                              <Badge key={p.id} variant="secondary" className="mr-1 text-sm">
                                {p.position} {p.name}
                              </Badge>
                            ))}
                            {trade.teamAPickValues.map((v, i) => (
                              <Badge key={i} variant="outline" className="mr-1 text-sm">
                                Pick ({v.toLocaleString()})
                              </Badge>
                            ))}
                          </div>
                        </div>

                        <div>
                          <p className="text-sm text-muted-foreground mb-2">
                            {getTeamName(trade.teamBId)} gives:
                          </p>
                          <div className="space-y-1">
                            {trade.teamBPlayers.map((p) => (
                              <Badge key={p.id} variant="secondary" className="mr-1 text-sm">
                                {p.position} {p.name}
                              </Badge>
                            ))}
                            {trade.teamBPickValues.map((v, i) => (
                              <Badge key={i} variant="outline" className="mr-1 text-sm">
                                Pick ({v.toLocaleString()})
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeSavedTrade(trade.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
