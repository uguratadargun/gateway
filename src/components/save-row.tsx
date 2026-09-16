"use client";

import { Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The footer every editable card on the dashboard ends in: one button, under
 * the controls it saves, disabled until something actually changed. It is the
 * page's single answer to "did my change stick?" — the panels used to give
 * three (autosave, a per-row button, a section-wide flash).
 */
export function SaveRow({
  dirty,
  busy,
  error,
  note,
  onSave,
  className,
}: {
  dirty: boolean;
  busy?: boolean;
  /** A failed PUT, shown next to the button rather than swallowed. */
  error?: string | null;
  /** Anything worth saying about this card's scope, shown while it is clean. */
  note?: string;
  onSave: () => void;
  className?: string;
}) {
  return (
    <CardFooter className={cn("justify-between gap-3 border-t pt-4", className)}>
      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? (dirty ? "Unsaved changes" : note ?? "")}
      </p>
      <Button size="sm" onClick={onSave} disabled={!dirty || busy}>
        <Save /> {busy ? "Saving…" : dirty ? "Save" : "Saved"}
      </Button>
    </CardFooter>
  );
}
