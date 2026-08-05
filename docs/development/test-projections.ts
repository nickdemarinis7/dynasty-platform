/**
 * Test script for Sleeper projections API
 * Run with: npx tsx test-projections.ts
 */

import { getWeeklyProjections, getCurrentNFLWeek, getPlayerSeasonProjections, getRestOfSeasonProjection } from "./src/lib/projections-api";

async function testProjectionsAPI() {
  console.log("🧪 Testing Sleeper Projections API...\n");
  
  // Test 1: Get current NFL week
  console.log("Test 1: Get current NFL week");
  const nflWeek = getCurrentNFLWeek();
  console.log(`Current: ${nflWeek.season} Week ${nflWeek.week} (Playoffs: ${nflWeek.isPlayoffs})\n`);
  
  // Test 2: Fetch weekly projections
  console.log("Test 2: Fetch weekly projections for current week");
  const weeklyProjections = await getWeeklyProjections(nflWeek.season, nflWeek.week);
  const playerCount = Object.keys(weeklyProjections).length;
  console.log(`✅ Fetched ${playerCount} player projections\n`);
  
  if (playerCount === 0) {
    console.log("⚠️  No projections available (might be off-season or API issue)");
    console.log("Trying 2024 Week 1 as fallback...\n");
    
    const fallbackProjections = await getWeeklyProjections(2024, 1);
    const fallbackCount = Object.keys(fallbackProjections).length;
    console.log(`Fallback: ${fallbackCount} projections for 2024 Week 1\n`);
    
    if (fallbackCount > 0) {
      // Show sample projection
      const samplePlayerId = Object.keys(fallbackProjections)[0];
      const sampleProj = fallbackProjections[samplePlayerId];
      console.log("Sample projection:");
      console.log(JSON.stringify(sampleProj, null, 2));
    }
  } else {
    // Test 3: Look for Patrick Mahomes (player_id: 4018)
    console.log("Test 3: Patrick Mahomes projection");
    const mahomesId = "4018";
    const mahomesProj = weeklyProjections[mahomesId];
    
    if (mahomesProj) {
      console.log(`✅ Found Patrick Mahomes projection:`);
      console.log(`   PPR: ${mahomesProj.stats?.pts_ppr?.toFixed(1) || 'N/A'} points`);
      console.log(`   Half-PPR: ${mahomesProj.stats?.pts_half_ppr?.toFixed(1) || 'N/A'} points`);
      console.log(`   Standard: ${mahomesProj.stats?.pts_std?.toFixed(1) || 'N/A'} points`);
      console.log(`   Pass Yards: ${mahomesProj.stats?.pass_yd || 'N/A'}`);
      console.log(`   Pass TDs: ${mahomesProj.stats?.pass_td || 'N/A'}`);
      console.log(`   Pass INTs: ${mahomesProj.stats?.pass_int || 'N/A'}\n`);
    } else {
      console.log(`⚠️  Patrick Mahomes not found in projections\n`);
    }
    
    // Test 4: Show top 5 projected players
    console.log("Test 4: Top 5 projected players (Half-PPR)");
    const sortedPlayers = Object.entries(weeklyProjections)
      .filter(([_, proj]) => proj.stats?.pts_half_ppr !== undefined)
      .sort(([_, a], [__, b]) => (b.stats?.pts_half_ppr || 0) - (a.stats?.pts_half_ppr || 0))
      .slice(0, 5);
    
    sortedPlayers.forEach(([playerId, proj], index) => {
      console.log(`${index + 1}. Player ${playerId}: ${proj.stats?.pts_half_ppr?.toFixed(1)} points`);
    });
    console.log();
  }
  
  // Test 5: Get season projections for a player
  console.log("Test 5: Get season projections for Patrick Mahomes");
  const seasonProjections = await getPlayerSeasonProjections("4018", 2024);
  const weekCount = Object.keys(seasonProjections).length;
  console.log(`✅ Fetched ${weekCount} weeks of projections\n`);
  
  if (weekCount > 0) {
    // Show first 3 weeks
    console.log("First 3 weeks:");
    for (let week = 1; week <= 3; week++) {
      const proj = seasonProjections[week];
      if (proj) {
        console.log(`Week ${week}: ${proj.stats?.pts_half_ppr?.toFixed(1) || 'N/A'} points`);
      }
    }
    console.log();
  }
  
  // Test 6: Calculate rest-of-season projection
  console.log("Test 6: Rest-of-season projection");
  const rosProjection = await getRestOfSeasonProjection("4018", 2024, 10, "half_ppr", 1.2);
  console.log(`✅ ROS projection (weeks 10-18): ${rosProjection.toFixed(1)} points`);
  console.log(`   (includes 1.2x playoff boost for weeks 15-17)\n`);
  
  console.log("✅ All tests complete!");
}

// Run tests
testProjectionsAPI().catch(error => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});
