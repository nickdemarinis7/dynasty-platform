/**
 * Inspect actual projection data structure
 */

import { getWeeklyProjections } from "./src/lib/projections-api";

async function inspectProjections() {
  console.log("🔍 Inspecting Sleeper projections data structure...\n");
  
  const projections = await getWeeklyProjections(2026, 1);
  console.log(`Total players: ${Object.keys(projections).length}\n`);
  
  // Get first 3 players
  const playerIds = Object.keys(projections).slice(0, 3);
  
  for (const playerId of playerIds) {
    console.log(`Player ID: ${playerId}`);
    console.log(JSON.stringify(projections[playerId], null, 2));
    console.log("\n---\n");
  }
  
  // Try to find a player with actual projection data
  console.log("Looking for players with projection data...\n");
  
  let found = 0;
  for (const [playerId, proj] of Object.entries(projections)) {
    if (proj && typeof proj === 'object' && Object.keys(proj).length > 3) {
      console.log(`Player ID: ${playerId}`);
      console.log(JSON.stringify(proj, null, 2));
      console.log("\n---\n");
      found++;
      if (found >= 3) break;
    }
  }
  
  if (found === 0) {
    console.log("No players with detailed projection data found.");
    console.log("This might be off-season or the API structure has changed.");
  }
}

inspectProjections().catch(console.error);
