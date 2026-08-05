"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Users,
  ArrowRightLeft,
  Lightbulb,
  Settings,
  Sliders,
  Trophy,
  History,
  ClipboardList,
  TrendingUp,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: BarChart3 },
  { href: "/league", label: "League Setup", icon: Settings },
  { href: "/draft", label: "Live Draft", icon: ClipboardList },
  { href: "/rosters", label: "Rosters", icon: Users },
  { href: "/rankings", label: "Power Rankings", icon: Trophy },
  { href: "/values", label: "Player Values", icon: Sliders },
  { href: "/trade", label: "Trade Simulator", icon: ArrowRightLeft },
  { href: "/recommendations", label: "Recommendations", icon: Lightbulb },
  { href: "/projections", label: "Edge Intelligence", icon: TrendingUp },
  { href: "/trade/history", label: "Trade History", icon: History },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 h-full w-64 border-r border-border bg-card flex flex-col z-50">
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-primary flex items-center justify-center flex-shrink-0 shadow-md shadow-primary/30">
            <Zap className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="font-bold text-[15px] leading-none tracking-tight">Dynasty</h1>
            <p className="text-[11px] text-muted-foreground mt-1 leading-none">Trade Intelligence</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/" && item.href !== "/trade" && pathname.startsWith(item.href)) ||
            (item.href === "/trade" && pathname === "/trade");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border">
        <p className="text-xs text-muted-foreground text-center">
          SF + TEP Dynasty
        </p>
      </div>
    </aside>
  );
}
