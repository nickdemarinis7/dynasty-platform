import { cn } from "@/lib/utils";

interface RecommendationFactorsProps {
  valueGain: number;
  positionalFit: number;
  windowAlignment: number;
  opponentFit: number;
  lineupPoints?: number;
  lineupSource?: "weekly_projection" | "season_fppg" | "market_value_estimate";
}

function tone(value: number, neutral = 50): string {
  if (value >= neutral + 15) return "text-green-400";
  if (value >= neutral - 10) return "text-yellow-400";
  return "text-orange-400";
}

export function RecommendationFactors({
  valueGain,
  positionalFit,
  windowAlignment,
  opponentFit,
  lineupPoints,
  lineupSource,
}: RecommendationFactorsProps) {
  const factors = [
    {
      label: "Market edge",
      value: `${valueGain > 0 ? "+" : ""}${Math.round(valueGain)}`,
      className: valueGain >= 0 ? "text-green-400" : "text-orange-400",
    },
    { label: "Roster need", value: `${Math.round(positionalFit)}/100`, className: tone(positionalFit) },
    { label: "Window fit", value: `${Math.round(windowAlignment)}/100`, className: tone(windowAlignment) },
    { label: "Opponent fit", value: `${Math.round(opponentFit)}/100`, className: tone(opponentFit) },
    ...(lineupPoints === undefined ? [] : [{
      label: lineupSource === "weekly_projection" ? "Lineup" : lineupSource === "season_fppg" ? "Season form" : "Est. lineup",
      value: `${lineupPoints > 0 ? "+" : ""}${lineupPoints.toFixed(1)} PPG`,
      className: lineupPoints > 0 ? "text-green-400" : lineupPoints < 0 ? "text-orange-400" : "text-muted-foreground",
    }]),
  ];

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Recommendation factors">
      {factors.map((factor) => (
        <div key={factor.label} className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{factor.label}</p>
          <p className={cn("text-xs font-semibold font-mono", factor.className)}>{factor.value}</p>
        </div>
      ))}
    </div>
  );
}
