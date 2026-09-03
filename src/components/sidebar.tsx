"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, LayoutDashboard, ListTree, LogOut, MessagesSquare, ScrollText } from "lucide-react";

import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/sessions", label: "Sessions", icon: ListTree },
  { href: "/traffic", label: "Traffic", icon: ScrollText },
  { href: "/playground", label: "Playground", icon: MessagesSquare },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/login") return null;

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r bg-muted/30 px-3 py-5">
      <div className="px-2 pb-6">
        <div className="text-lg font-semibold tracking-tight">gate</div>
        <div className="text-xs text-muted-foreground">claude gateway</div>
      </div>
      <nav className="flex flex-col gap-1">
        {links.map((l) => {
          const active = pathname === l.href;
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {l.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto space-y-3">
        <button
          onClick={logout}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
        >
          <LogOut className="size-4" />
          Sign out
        </button>
        <div className="px-2 text-[11px] text-muted-foreground">Personal use · your own account</div>
      </div>
    </aside>
  );
}
