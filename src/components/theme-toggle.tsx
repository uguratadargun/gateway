"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Light / dark / follow-the-system, as three buttons rather than one that
 * cycles: with a cycling toggle you cannot tell which of the three you are in,
 * and "system" is invisible until the OS changes underneath you.
 *
 * The class is written to <html> by the inline script in the layout before
 * first paint; this only has to keep it in step afterwards.
 */

export type ThemeChoice = "light" | "dark" | "system";

/** Shared with the pre-paint script in the layout, which cannot import from here. */
export const THEME_KEY = "gate-theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

const OPTIONS: Array<{ value: ThemeChoice; icon: typeof Sun; label: string }> = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
];

export function ThemeToggle() {
  // "dark" matches what the layout renders, so the first paint agrees with the
  // server; the stored choice is read in the effect below.
  const [choice, setChoice] = useState<ThemeChoice>("dark");

  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY) as ThemeChoice | null;
    if (stored === "light" || stored === "dark" || stored === "system") setChoice(stored);
  }, []);

  // Following the system means following it as it changes, not only at load.
  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  function pick(next: ThemeChoice) {
    setChoice(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // A browser with site data blocked still gets the theme for this tab.
    }
    applyTheme(next);
  }

  return (
    <div
      className="flex items-center gap-0.5 rounded-md border bg-background/85 p-0.5 shadow-sm backdrop-blur"
      role="group"
      aria-label="Theme"
    >
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => pick(value)}
          title={label}
          aria-label={label}
          aria-pressed={choice === value}
          className={cn(
            "flex items-center justify-center rounded px-1.5 py-0.5 transition-colors",
            choice === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3" />
        </button>
      ))}
    </div>
  );
}
