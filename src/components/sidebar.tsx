"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowRightLeft, BarChart3, ClipboardList, History, Lightbulb, Menu,
  Settings, Sliders, TrendingUp, Trophy, Users, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

const navItems = [
  { href: "/", label: "Dashboard", shortLabel: "Home", icon: BarChart3 },
  { href: "/league", label: "League Setup", shortLabel: "League", icon: Settings },
  { href: "/draft", label: "Live Draft", shortLabel: "Draft", icon: ClipboardList },
  { href: "/rosters", label: "Rosters", shortLabel: "Rosters", icon: Users },
  { href: "/rankings", label: "Power Rankings", shortLabel: "Ranks", icon: Trophy },
  { href: "/values", label: "Player Values", shortLabel: "Values", icon: Sliders },
  { href: "/trade", label: "Trade Simulator", shortLabel: "Trade", icon: ArrowRightLeft },
  { href: "/recommendations", label: "Recommendations", shortLabel: "Ideas", icon: Lightbulb },
  { href: "/projections", label: "Edge Intelligence", shortLabel: "Edge", icon: TrendingUp },
  { href: "/trade/history", label: "Trade History", shortLabel: "History", icon: History },
] as const;

const mobilePrimaryHrefs = new Set(["/", "/rosters", "/trade", "/rankings"]);

function isRouteActive(pathname: string, href: string) {
  return pathname === href ||
    (href !== "/" && href !== "/trade" && pathname.startsWith(href)) ||
    (href === "/trade" && pathname === "/trade");
}

export function Sidebar() {
  const leagueMode = useAppStore((state) => state.leagueSettings?.mode);
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const primaryItems = navItems.filter((item) => mobilePrimaryHrefs.has(item.href));
  const moreItems = navItems.filter((item) => !mobilePrimaryHrefs.has(item.href));
  const moreIsActive = moreItems.some((item) => isRouteActive(pathname, item.href));

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-border bg-card lg:flex">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary shadow-md shadow-primary/30">
              <Zap className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-[15px] font-bold leading-none tracking-tight">Fantasy GM</h1>
              <p className="mt-1 text-[11px] leading-none text-muted-foreground">Trade Intelligence</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-4" aria-label="Primary navigation">
          {navItems.map((item) => {
            const active = isRouteActive(pathname, item.href);
            return (
              <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}>
                <item.icon className="h-4 w-4" />{item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border p-4">
          <p className="text-center text-xs text-muted-foreground">
            {leagueMode ? `${leagueMode[0].toUpperCase()}${leagueMode.slice(1)} League` : "Dynasty + Redraft"}
          </p>
        </div>
      </aside>

      <nav className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-card/95 px-1 backdrop-blur-xl lg:hidden" aria-label="Mobile navigation">
        {primaryItems.map((item) => {
          const active = isRouteActive(pathname, item.href);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
              className={cn("flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10px] font-medium", active ? "text-primary" : "text-muted-foreground")}>
              <item.icon className="h-5 w-5" /><span>{item.shortLabel}</span>
            </Link>
          );
        })}
        <button type="button" onClick={() => setMoreOpen(true)} aria-expanded={moreOpen}
          className={cn("flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10px] font-medium", moreIsActive ? "text-primary" : "text-muted-foreground")}>
          <Menu className="h-5 w-5" /><span>More</span>
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="max-h-[82dvh] rounded-t-3xl pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden">
          <SheetHeader className="border-b border-border">
            <SheetTitle>More tools</SheetTitle>
            <SheetDescription>{leagueMode ? `${leagueMode} league workspace` : "Dynasty and redraft workspace"}</SheetDescription>
          </SheetHeader>
          <nav className="grid grid-cols-2 gap-2 overflow-y-auto px-4 pb-2" aria-label="Additional navigation">
            {moreItems.map((item) => {
              const active = isRouteActive(pathname, item.href);
              return (
                <Link key={item.href} href={item.href} onClick={() => setMoreOpen(false)}
                  className={cn("flex min-h-16 items-center gap-3 rounded-2xl border border-border p-3 text-sm font-medium", active ? "bg-primary/10 text-primary" : "bg-muted/30 text-foreground")}>
                  <item.icon className="h-5 w-5 shrink-0" />{item.label}
                </Link>
              );
            })}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}
