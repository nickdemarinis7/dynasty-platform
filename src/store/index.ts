"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LeagueSettings, Player, TeamRoster, DraftPick, HistoricalTradeAnalysis, PlayerSeasonStats } from "@/types";

function currentNFLSeason(): string {
  const now = new Date();
  return String(now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear());
}

export function arePlayerStatsStale(
  lastFetched: number | null,
  now: number = Date.now(),
  maxAgeMs: number = 6 * 60 * 60 * 1000,
): boolean {
  return lastFetched === null || !Number.isFinite(lastFetched) || now - lastFetched >= maxAgeMs;
}

interface AppState {
  // League
  leagueSettings: LeagueSettings | null;
  setLeagueSettings: (settings: LeagueSettings) => void;

  // Rosters
  rosters: TeamRoster[];
  setRosters: (rosters: TeamRoster[]) => void;
  myTeamId: string | null;
  setMyTeamId: (id: string) => void;

  // Players
  players: Record<string, Player>;
  setPlayers: (players: Record<string, Player>) => void;

  // Personal values (player ID -> custom value)
  personalValues: Record<string, number>;
  setPersonalValue: (playerId: string, value: number) => void;
  removePersonalValue: (playerId: string) => void;
  clearPersonalValues: () => void;

  // Sleeper connection
  sleeperUsername: string | null;
  sleeperLeagueId: string | null;
  setSleeperConnection: (username: string, leagueId: string) => void;
  clearSleeperConnection: () => void;

  // Trade history
  savedTrades: SavedTrade[];
  addSavedTrade: (trade: SavedTrade) => void;
  removeSavedTrade: (id: string) => void;

  // Trade recommendation feedback
  tradeFeedback: TradeFeedback[];
  addTradeFeedback: (feedback: TradeFeedback) => void;

  // Historical trade analysis
  tradeAnalysis: HistoricalTradeAnalysis | null;
  setTradeAnalysis: (analysis: HistoricalTradeAnalysis) => void;

  dataFreshness: DataFreshness | null;
  setDataFreshness: (freshness: DataFreshness) => void;

  // Player season stats (from Sleeper) for projection engine
  playerStats: Record<string, PlayerSeasonStats>;
  statsLoading: boolean;
  statsError: string | null;
  statsLastFetched: number | null;
  setPlayerStats: (stats: Record<string, PlayerSeasonStats>) => void;
  loadPlayerStats: (season?: string) => Promise<void>;

  // Clear all data
  clearAllData: () => void;
}

export interface DataFreshness {
  leagueImportedAt: number;
  fantasyCalcFetchedAt: number | null;
  fantasyCalcStatus: "live" | "fallback";
}

export interface SavedTrade {
  id: string;
  timestamp: number;
  teamAId: string;
  teamAPlayers: Player[];
  teamAPicks: DraftPick[];
  teamBId: string;
  teamBPlayers: Player[];
  teamBPicks: DraftPick[];
  fairnessScore: number;
  notes?: string;
}

export interface TradeFeedback {
  id: string;
  timestamp: number;
  targetPlayerId: string;
  targetPosition: string;
  offeredPlayerIds: string[];
  offeredPositions: string[];
  reaction: "thumbs_up" | "thumbs_down" | "dismissed";
  reason?: string;
  priority: "high" | "medium" | "low";
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      leagueSettings: null,
      setLeagueSettings: (settings) => set({ leagueSettings: settings }),

      rosters: [],
      setRosters: (rosters) => set({ rosters }),
      myTeamId: null,
      setMyTeamId: (id) => set({ myTeamId: id }),

      players: {},
      setPlayers: (players) => set({ players }),

      personalValues: {},
      setPersonalValue: (playerId, value) =>
        set((state) => ({
          personalValues: { ...state.personalValues, [playerId]: value },
        })),
      removePersonalValue: (playerId) =>
        set((state) => {
          const rest = { ...state.personalValues };
          delete rest[playerId];
          return { personalValues: rest };
        }),
      clearPersonalValues: () => set({ personalValues: {} }),

      sleeperUsername: null,
      sleeperLeagueId: null,
      setSleeperConnection: (username, leagueId) =>
        set({ sleeperUsername: username, sleeperLeagueId: leagueId }),
      clearSleeperConnection: () =>
        set({ sleeperUsername: null, sleeperLeagueId: null }),

      savedTrades: [],
      addSavedTrade: (trade) =>
        set((state) => ({ savedTrades: [trade, ...state.savedTrades] })),
      removeSavedTrade: (id) =>
        set((state) => ({
          savedTrades: state.savedTrades.filter((t) => t.id !== id),
        })),

      tradeFeedback: [],
      addTradeFeedback: (feedback) =>
        set((state) => ({ tradeFeedback: [feedback, ...state.tradeFeedback] })),

      tradeAnalysis: null,
      setTradeAnalysis: (analysis) => set({ tradeAnalysis: analysis }),
      dataFreshness: null,
      setDataFreshness: (dataFreshness) => set({ dataFreshness }),

      playerStats: {},
      statsLoading: false,
      statsError: null,
      statsLastFetched: null,
      setPlayerStats: (stats) => set({ playerStats: stats, statsLastFetched: Date.now(), statsError: null }),
      loadPlayerStats: async (season = currentNFLSeason()) => {
        set({ statsLoading: true, statsError: null });
        try {
          const res = await fetch(`/api/sleeper/stats?season=${season}`);
          if (!res.ok) throw new Error("Season stats are temporarily unavailable");
          const stats = await res.json();
          set({ playerStats: stats, statsLastFetched: Date.now(), statsError: null });
        } catch (error) {
          set({ statsError: error instanceof Error ? error.message : "Season stats are temporarily unavailable" });
        } finally {
          set({ statsLoading: false });
        }
      },

      clearAllData: () =>
        set({
          leagueSettings: null,
          rosters: [],
          myTeamId: null,
          players: {},
          personalValues: {},
          savedTrades: [],
          tradeFeedback: [],
          tradeAnalysis: null,
          dataFreshness: null,
          playerStats: {},
          statsLoading: false,
          statsError: null,
          statsLastFetched: null,
          sleeperUsername: null,
          sleeperLeagueId: null,
        }),
    }),
    {
      name: "dynasty-trade-sim-v2",
      version: 3,
      migrate: (persistedState: unknown, version) => {
        if (!persistedState || typeof persistedState !== "object" || version >= 3) {
          return persistedState as AppState;
        }

        const state = persistedState as Record<string, unknown>;
        const savedTrades = version < 1 && Array.isArray(state.savedTrades)
          ? state.savedTrades.map((value) => {
              const trade = value as Record<string, unknown>;
              const legacyPicks = (key: string, currentOwner: unknown): DraftPick[] =>
                Array.isArray(trade[key])
                  ? (trade[key] as number[]).map((estimatedValue) => ({
                      year: 0,
                      round: 0,
                      originalOwner: "unknown",
                      currentOwner: String(currentOwner ?? "unknown"),
                      estimatedValue,
                    }))
                  : [];

              return {
                ...trade,
                teamAPicks: legacyPicks("teamAPickValues", trade.teamAId),
                teamBPicks: legacyPicks("teamBPickValues", trade.teamBId),
                teamAPickValues: undefined,
                teamBPickValues: undefined,
              };
            })
          : (state.savedTrades ?? []);

        const leagueSettings = state.leagueSettings && typeof state.leagueSettings === "object"
          ? { mode: "dynasty", ...state.leagueSettings as Record<string, unknown> }
          : state.leagueSettings;

        return {
          ...state,
          leagueSettings,
          savedTrades,
          dataFreshness: state.dataFreshness ?? null,
        } as unknown as AppState;
      },
    }
  )
);
