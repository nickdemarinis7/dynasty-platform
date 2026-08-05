"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LeagueSettings, Player, TeamRoster, DraftPick, HistoricalTradeAnalysis, PlayerSeasonStats } from "@/types";

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

  // Player season stats (from Sleeper) for projection engine
  playerStats: Record<string, PlayerSeasonStats>;
  statsLoading: boolean;
  statsLastFetched: number | null;
  setPlayerStats: (stats: Record<string, PlayerSeasonStats>) => void;
  loadPlayerStats: (season?: string) => Promise<void>;

  // Clear all data
  clearAllData: () => void;
}

export interface SavedTrade {
  id: string;
  timestamp: number;
  teamAId: string;
  teamAPlayers: Player[];
  teamAPickValues: number[];
  teamBId: string;
  teamBPlayers: Player[];
  teamBPickValues: number[];
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
          const { [playerId]: _, ...rest } = state.personalValues;
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

      playerStats: {},
      statsLoading: false,
      statsLastFetched: null,
      setPlayerStats: (stats) => set({ playerStats: stats, statsLastFetched: Date.now() }),
      loadPlayerStats: async (season = "2025") => {
        set({ statsLoading: true });
        try {
          const res = await fetch(`/api/sleeper/stats?season=${season}`);
          if (!res.ok) throw new Error("Stats fetch failed");
          const stats = await res.json();
          set({ playerStats: stats, statsLastFetched: Date.now() });
        } catch (e) {
          console.error("Failed to load player stats:", e);
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
          playerStats: {},
          statsLastFetched: null,
        }),
    }),
    {
      name: "dynasty-trade-sim-v2",
    }
  )
);
