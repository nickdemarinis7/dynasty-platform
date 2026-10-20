import type { TradeIdea } from "./types.ts";

export function recommendationTradeParams(idea: TradeIdea, myTeamId: string): URLSearchParams {
  const params = new URLSearchParams({
    teamA: myTeamId,
    teamB: idea.targetTeamId,
    source: "recommendation",
  });

  if (idea.type === "sell") {
    if (idea.receivingPicks?.length) {
      params.set("playersA", idea.targetPlayer.id);
    } else if (idea.offeredPlayers.length) {
      params.set("playersA", idea.offeredPlayers.map((player) => player.id).join(","));
      params.set("playersB", idea.targetPlayer.id);
    }
  } else {
    if (idea.offeredPlayers.length) {
      params.set("playersA", idea.offeredPlayers.map((player) => player.id).join(","));
    }
    params.set("playersB", idea.targetPlayer.id);
  }

  if (idea.offeredPicks?.length) {
    params.set("picksA", idea.offeredPicks.map((pick) => `${pick.year}-${pick.round}`).join(","));
  }
  if (idea.receivingPicks?.length) {
    params.set("picksB", idea.receivingPicks.map((pick) => `${pick.year}-${pick.round}`).join(","));
  }

  return params;
}
