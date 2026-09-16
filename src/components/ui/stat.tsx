import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One figure in a row of figures. The overview and the usage panel each had
 * their own copy of this; they read as one row of tiles on the page, so they
 * are one component.
 */
export function Stat({
  label,
  value,
  hint,
  icon,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  /** Colours the value only; the frame stays neutral so a row reads evenly. */
  tone?: "ok" | "warning" | "critical";
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border bg-muted/40 p-3", className)}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          tone === "warning" && "text-amber-500",
          tone === "critical" && "text-destructive",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
