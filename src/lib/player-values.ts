import type { Player } from "@/types";

// Dynasty player values - SF + TEP adjusted
// Scale: 0-100 (100 = most valuable asset in dynasty, like Madden overall)
// These are baseline values; users can override with personal values
export const DEFAULT_DYNASTY_VALUES: Record<string, number> = {
  // Elite QBs (SF premium)
  "Josh Allen": 98,
  "Lamar Jackson": 96,
  "Jalen Hurts": 94,
  "Patrick Mahomes": 93,
  "Joe Burrow": 92,
  "C.J. Stroud": 91,
  "Anthony Richardson": 88,
  "Jayden Daniels": 89,
  "Caleb Williams": 87,
  "Drake Maye": 85,
  "Brock Purdy": 82,
  "Dak Prescott": 78,
  "Jordan Love": 79,
  "Kyler Murray": 76,
  "Tua Tagovailoa": 74,
  "Trevor Lawrence": 75,
  "Justin Herbert": 77,
  "Jared Goff": 70,
  "Baker Mayfield": 68,
  "Sam Darnold": 62,
  "Bo Nix": 71,
  "Matthew Stafford": 58,
  "Aaron Rodgers": 52,
  "Kirk Cousins": 50,
  "Russell Wilson": 48,
  "Deshaun Watson": 45,
  "Daniel Jones": 42,
  "Bryce Young": 60,

  // Elite RBs
  "Bijan Robinson": 90,
  "Breece Hall": 85,
  "Jahmyr Gibbs": 87,
  "Jonathan Taylor": 78,
  "Saquon Barkley": 76,
  "De'Von Achane": 83,
  "Kenneth Walker III": 72,
  "Kyren Williams": 70,
  "Josh Jacobs": 62,
  "Derrick Henry": 55,
  "Isiah Pacheco": 71,
  "James Cook": 73,
  "Travis Etienne": 68,
  "Alvin Kamara": 58,
  "Aaron Jones": 54,
  "Rachaad White": 60,
  "Najee Harris": 61,
  "David Montgomery": 56,
  "Rhamondre Stevenson": 64,
  "Tony Pollard": 59,
  "Javonte Williams": 58,
  "Zack Moss": 52,
  "Joe Mixon": 54,
  "Nick Chubb": 50,
  "Jonathon Brooks": 74,
  "Trey Benson": 68,
  "Blake Corum": 58,
  "Bucky Irving": 69,

  // Elite WRs
  "Ja'Marr Chase": 95,
  "CeeDee Lamb": 92,
  "Justin Jefferson": 94,
  "Amon-Ra St. Brown": 88,
  "Tyreek Hill": 72,
  "A.J. Brown": 84,
  "Puka Nacua": 89,
  "Malik Nabers": 90,
  "Marvin Harrison Jr.": 86,
  "Garrett Wilson": 82,
  "Drake London": 81,
  "Chris Olave": 78,
  "Nico Collins": 79,
  "DK Metcalf": 74,
  "Davante Adams": 60,
  "Stefon Diggs": 58,
  "DeVonta Smith": 76,
  "Brandon Aiyuk": 75,
  "Jaylen Waddle": 73,
  "DJ Moore": 68,
  "Terry McLaurin": 66,
  "Mike Evans": 62,
  "Amari Cooper": 56,
  "Keenan Allen": 54,
  "Rashee Rice": 78,
  "Jaxon Smith-Njigba": 77,
  "Tank Dell": 74,
  "Quentin Johnston": 66,
  "George Pickens": 72,
  "Ladd McConkey": 76,
  "Brian Thomas Jr.": 80,
  "Rome Odunze": 74,
  "Xavier Worthy": 71,
  "Jameson Williams": 70,
  "Zay Flowers": 75,
  "Tee Higgins": 70,

  // More WRs
  "Calvin Ridley": 52,
  "Christian Kirk": 50,
  "Diontae Johnson": 48,
  "Courtland Sutton": 54,
  "Michael Pittman Jr.": 56,
  "Josh Downs": 62,
  "Wan'Dale Robinson": 52,
  "Rashod Bateman": 46,
  "Dontayvion Wicks": 48,
  "Khalil Shakir": 56,
  "Curtis Samuel": 38,
  "Tyler Lockett": 36,
  "Adam Thielen": 34,
  "Allen Lazard": 32,
  "Christian Watson": 58,
  "Jayden Reed": 60,
  "Romeo Doubs": 56,
  "Adonai Mitchell": 54,
  "Troy Franklin": 48,
  "Keon Coleman": 58,
  "Xavier Legette": 52,
  "Ja'Lynn Polk": 44,
  "Luke McCaffrey": 46,

  // More RBs
  "Rico Dowdle": 54,
  "Chuba Hubbard": 52,
  "D'Andre Swift": 50,
  "Jerome Ford": 42,
  "Tyler Allgeier": 44,
  "Chase Brown": 56,
  "Jaylen Wright": 50,
  "Ray Davis": 48,
  "Tyrone Tracy Jr.": 52,
  "Kimani Vidal": 44,
  "MarShawn Lloyd": 46,
  "Tyjae Spears": 54,
  "Deuce Vaughn": 32,
  "Zamir White": 46,
  "Brian Robinson Jr.": 48,
  "Austin Ekeler": 42,
  "Roschon Johnson": 38,
  "Jaylen Warren": 44,

  // 2025 Rookies
  "Travis Hunter": 88,
  "Ashton Jeanty": 84,
  "Tetairoa McMillan": 78,
  "Luther Burden III": 76,
  "Shedeur Sanders": 74,
  "Cam Ward": 78,
  "Omarion Hampton": 70,
  "Kaleb Johnson": 64,
  "Isaiah Bond": 58,
  "Emeka Egbuka": 56,
  "Quinshon Judkins": 62,
  "Deion Colzie": 48,
  "Tyler Warren": 72,
  "Mason Taylor": 54,
  "Colston Loveland": 60,
  "Jalen Milroe": 56,
  "Tre Harris": 60,
  "Elic Ayomanor": 52,
  "Matthew Golden": 50,

  // Elite TEs (TEP premium)
  "Sam LaPorta": 85,
  "Brock Bowers": 88,
  "Trey McBride": 80,
  "Travis Kelce": 68,
  "Mark Andrews": 66,
  "George Kittle": 64,
  "Dallas Goedert": 62,
  "Kyle Pitts": 72,
  "David Njoku": 60,
  "Dalton Kincaid": 74,
  "Evan Engram": 58,
  "T.J. Hockenson": 66,
  "Pat Freiermuth": 60,
  "Jake Ferguson": 62,

  // More TEs
  "Cole Kmet": 54,
  "Cade Otton": 52,
  "Dalton Schultz": 46,
  "Taysom Hill": 38,
  "Noah Fant": 42,
  "Mike Gesicki": 40,
  "Juwan Johnson": 36,
  "Chigoziem Okonkwo": 50,
  "Tucker Kraft": 56,
  "Ben Sinnott": 48,

  // More QBs
  "Will Levis": 58,
  "Aidan O'Connell": 48,
  "Spencer Rattler": 42,
  "Jameis Winston": 38,
  "Justin Fields": 56,
  "Geno Smith": 50,
  "Sam Howell": 36,
  "Malik Willis": 40,
  "Michael Penix Jr.": 54,

  // Draft Picks (approximate values)
  "2025 1st (Early)": 80,
  "2025 1st (Mid)": 72,
  "2025 1st (Late)": 65,
  "2025 2nd (Early)": 55,
  "2025 2nd (Mid)": 50,
  "2025 2nd (Late)": 45,
  "2025 3rd": 30,
  "2026 1st (Early)": 75,
  "2026 1st (Mid)": 68,
  "2026 1st (Late)": 60,
  "2026 2nd (Early)": 50,
  "2026 2nd (Mid)": 45,
  "2026 2nd (Late)": 40,
  "2026 3rd": 25,
  "2027 1st": 60,
  "2027 2nd": 40,
  "2027 3rd": 20,
};

export function getPlayerValue(
  player: Player,
  personalValues: Record<string, number> = {}
): number {
  if (personalValues[player.id] !== undefined) return personalValues[player.id];
  if (player.personalValue !== undefined) return player.personalValue;
  const raw = player.dynastyValue || DEFAULT_DYNASTY_VALUES[player.name] || 0;
  // Safety: if value is on old 0-10000 FantasyCalc scale, normalize to 0-100
  return raw > 150 ? Math.min(100, Math.round(raw / 100)) : raw;
}

export function getPickValue(
  year: number,
  round: number,
  projected: "early" | "mid" | "late" = "mid"
): number {
  const key = `${year} ${round === 1 ? "1st" : round === 2 ? "2nd" : "3rd"} (${projected.charAt(0).toUpperCase() + projected.slice(1)})`;
  return DEFAULT_DYNASTY_VALUES[key] || 20;
}

export function calculatePositionalNeed(
  roster: Player[],
  rosterSlots: { type: string; count: number }[],
  superflex: boolean,
  personalValues: Record<string, number> = {}
): Record<string, number> {
  // Normalize a raw dynasty value to 0-100 scale.
  // FantasyCalc values are 0-10000; DEFAULT_DYNASTY_VALUES are already 0-100.
  // Anything over 150 is assumed to be on the FantasyCalc scale.
  const norm = (v: number) => (v > 150 ? Math.min(100, Math.round(v / 100)) : Math.min(100, v));

  // Group players by position sorted by normalised value (best first)
  const byPosition: Record<string, number[]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const p of roster) {
    if (byPosition[p.position] !== undefined) {
      const raw = personalValues[p.id] ?? p.personalValue ?? (p.dynastyValue || DEFAULT_DYNASTY_VALUES[p.name] || 0);
      byPosition[p.position].push(norm(raw));
    }
  }
  for (const pos of Object.keys(byPosition)) {
    byPosition[pos].sort((a, b) => b - a); // best first
  }

  // Derive slot counts
  let qbSlots = 0, rbSlots = 0, wrSlots = 0, teSlots = 0, flexSlots = 0, sfSlots = 0;
  for (const slot of rosterSlots) {
    switch (slot.type) {
      case "QB": qbSlots += slot.count; break;
      case "RB": rbSlots += slot.count; break;
      case "WR": wrSlots += slot.count; break;
      case "TE": teSlots += slot.count; break;
      case "FLEX": flexSlots += slot.count; break;
      case "SUPERFLEX": sfSlots += slot.count; break;
    }
  }

  // How many starters to evaluate quality against (flex contribution included)
  const starterCounts: Record<string, number> = {
    QB: Math.max(superflex ? qbSlots + Math.ceil(sfSlots * 0.5) : qbSlots, 1),
    RB: Math.max(rbSlots + Math.ceil(flexSlots * 0.4), 1),
    WR: Math.max(wrSlots + Math.ceil(flexSlots * 0.4), 1),
    TE: Math.max(teSlots, 1),
  };

  // Ideal total depth = starters + bench backup
  const idealDepth: Record<string, number> = {
    QB: Math.max(superflex ? qbSlots + sfSlots + 1 : qbSlots + 1, superflex ? 3 : 2),
    RB: Math.max(rbSlots + Math.ceil(flexSlots * 0.4) + 2, 5),
    WR: Math.max(wrSlots + Math.ceil(flexSlots * 0.4) + 2, 6),
    TE: Math.max(teSlots + 1, 2),
  };

  // Minimum value threshold PER STARTER at a healthy position (0-100 normalised scale).
  // "Stacked" means your starters average at or above this threshold.
  // SF QB is raised to 68: second/third-tier SF QBs normalise to ~30-50 and should
  // register as genuine need, not show as "stacked."
  // Minimum average normalised value PER STARTER to be considered "solid" at that position.
  // Raising RB/WR thresholds: having a couple mid-tier starters (value ~40-50) shouldn't
  // register as "stacked"; only genuinely elite cores (avg 55+) should clear the bar.
  const starterThreshold: Record<string, number> = {
    QB: superflex ? 68 : 40,
    RB: 55,
    WR: 53,
    TE: 33,
  };

  const needs: Record<string, number> = {};
  for (const pos of Object.keys(idealDepth)) {
    const players = byPosition[pos] || [];
    const current = players.length;
    const ideal = idealDepth[pos];
    const starterN = starterCounts[pos];

    // Quantity need (0-30): how far below ideal total depth we are
    // If we have AT LEAST ideal depth, quantity need is 0
    const quantityNeed = current >= ideal ? 0 : Math.max(0, (ideal - current) / ideal) * 30;

    // Quality need (0-70): measured against TOP N starters only.
    // Having 4 low-value bench players doesn't inflate need — only starter quality counts.
    const myStarterValues = players.slice(0, starterN);
    const myStarterTotal = myStarterValues.reduce((s, v) => s + v, 0);
    const expectedStarterTotal = starterThreshold[pos] * starterN;
    const rawQualityNeed = myStarterTotal < expectedStarterTotal
      ? ((expectedStarterTotal - myStarterTotal) / expectedStarterTotal) * 70
      : 0;

    // Depth surplus dampener: only when you have 4+ ABOVE ideal depth (genuinely bloated),
    // soften quality need to 30% max — signals "bench depth fine, just developing".
    // Threshold raised from +2 → +4: at ideal+2 (e.g. 8 WRs vs ideal 6) quality need
    // was being capped at 30 which is below the badge threshold, permanently hiding the gap.
    const qualityNeed = current >= ideal + 4 ? Math.min(rawQualityNeed, 30) : rawQualityNeed;

    needs[pos] = Math.min(100, quantityNeed + qualityNeed);
  }

  return needs;
}

export function getTeamWindowLabel(roster: Player[]): {
  label: string;
  color: string;
  score: number;
} {
  if (roster.length === 0) return { label: "Unknown", color: "text-muted-foreground", score: 0 };

  const ages = roster
    .filter((p) => p.age > 0 && ["QB", "RB", "WR", "TE"].includes(p.position))
    .map((p) => p.age);

  if (ages.length === 0) return { label: "Unknown", color: "text-muted-foreground", score: 0 };

  const avgAge = ages.reduce((sum, a) => sum + a, 0) / ages.length;
  const youngCount = ages.filter((a) => a <= 24).length;
  const oldCount = ages.filter((a) => a >= 29).length;
  const youngPct = youngCount / ages.length;

  if (avgAge <= 24 && youngPct > 0.6) {
    return { label: "Rebuilding", color: "text-blue-400", score: -2 };
  }
  if (avgAge <= 25.5) {
    return { label: "Young Core", color: "text-cyan-400", score: -1 };
  }
  if (avgAge <= 27) {
    return { label: "Competing", color: "text-green-400", score: 1 };
  }
  if (oldCount > youngCount) {
    return { label: "Win Now", color: "text-yellow-400", score: 2 };
  }
  return { label: "Balanced", color: "text-gray-400", score: 0 };
}

export function analyzeTradeValue(
  teamAPlayers: Player[],
  teamAPickValues: number[],
  teamBPlayers: Player[],
  teamBPickValues: number[],
  personalValues: Record<string, number>
): {
  teamATotal: number;
  teamBTotal: number;
  difference: number;
  fairnessScore: number;
} {
  const teamATotal =
    teamAPlayers.reduce((sum, p) => sum + getPlayerValue(p, personalValues), 0) +
    teamAPickValues.reduce((sum, v) => sum + v, 0);

  const teamBTotal =
    teamBPlayers.reduce((sum, p) => sum + getPlayerValue(p, personalValues), 0) +
    teamBPickValues.reduce((sum, v) => sum + v, 0);

  const difference = teamATotal - teamBTotal;
  const maxValue = Math.max(teamATotal, teamBTotal);
  const fairnessScore = maxValue > 0 ? (difference / maxValue) * 100 : 0;

  return { teamATotal, teamBTotal, difference, fairnessScore };
}
