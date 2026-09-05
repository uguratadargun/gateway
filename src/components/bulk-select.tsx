"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Selecting rows on a list page and deleting them together.
 *
 * Deletion already existed, but only on a detail page: clearing out a handful
 * of agents meant opening each one, deleting, and coming back. A clear-out
 * happens where the list is, so the selection lives here.
 *
 * It stays out of the way until it is used. A row shows its handle on hover,
 * and the actions appear as a floating bar only once something is selected —
 * a list you are reading should look like a list, not like a form.
 */

export interface Selection {
  selected: Set<string>;
  active: boolean;
  toggle(id: string): void;
  toggleAll(): void;
  clear(): void;
  allSelected: boolean;
}

export function useSelection(ids: string[]): Selection {
  const [raw, setRaw] = useState<Set<string>>(new Set());
  const key = ids.join(" ");

  // A row that has gone (deleted, or reloaded away) must not stay selected, or
  // the bar counts things that are no longer on screen and "delete" fires at
  // ids the server no longer has.
  const selected = useMemo(() => {
    const live = new Set(key ? key.split(" ") : []);
    return new Set([...raw].filter((id) => live.has(id)));
  }, [raw, key]);

  return {
    selected,
    active: selected.size > 0,
    allSelected: ids.length > 0 && selected.size === ids.length,
    toggle(id) {
      setRaw((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    },
    toggleAll() {
      setRaw((prev) => (prev.size >= ids.length ? new Set() : new Set(ids)));
    },
    clear() {
      setRaw(new Set());
    },
  };
}

/**
 * The handle on a row: invisible until the row is hovered, the box is focused,
 * or a selection is already under way. Space is reserved either way, so nothing
 * shifts as it appears.
 */
export function SelectHandle({
  checked,
  active,
  onChange,
  label,
}: {
  checked: boolean;
  active: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-all",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/40 bg-background hover:border-muted-foreground",
        checked || active
          ? "opacity-100"
          : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100",
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}

/** Row styling for a selected item; keeps the three lists consistent. */
export function rowClass(selected: boolean): string {
  return cn(
    "group flex items-center gap-3 px-4 py-3 text-sm transition-colors",
    selected ? "border-primary/40 bg-primary/5" : "hover:bg-muted/40",
  );
}

/**
 * The actions, as a bar that floats over the list and exists only while
 * something is selected.
 */
export function SelectionBar({
  selection,
  total,
  noun,
  onDelete,
  busy,
}: {
  selection: Selection;
  total: number;
  noun: string;
  onDelete: () => void;
  busy?: boolean;
}) {
  const count = selection.selected.size;
  if (count === 0) return null;
  return (
    <div className="pointer-events-none sticky bottom-6 z-20 flex justify-center pt-2">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border bg-background/95 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur">
        <span className="mr-1 text-xs text-muted-foreground">
          {count} of {total} {noun}
        </span>
        {!selection.allSelected && (
          <Button variant="ghost" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={selection.toggleAll}>
            Select all
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={selection.clear} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-7 rounded-full px-3 text-xs"
          onClick={onDelete}
          disabled={busy}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
        </Button>
      </div>
    </div>
  );
}

/**
 * Deletes one id at a time and reports what refused, rather than failing the
 * whole batch on the first error: a partly-successful clear-out should say so.
 */
export async function deleteMany(path: (id: string) => string, ids: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const id of ids) {
    try {
      const res = await fetch(path(id), { method: "DELETE" });
      if (!res.ok) failed.push(id);
    } catch {
      failed.push(id);
    }
  }
  return failed;
}
