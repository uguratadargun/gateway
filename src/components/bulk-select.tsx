"use client";

import { useMemo, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Selecting rows on a list page and deleting them together.
 *
 * Deletion already existed, but only on a detail page: clearing out a handful
 * of agents meant opening each one, deleting, and coming back. A clear-out
 * happens where the list is, so the selection lives here.
 */

export interface Selection {
  selected: Set<string>;
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

export function SelectBox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="size-4 shrink-0 cursor-pointer accent-foreground"
    />
  );
}

/**
 * The header above a list: select-all on the left, and the delete action only
 * once something is selected.
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
  return (
    <div className="flex items-center gap-3 px-4 text-sm">
      <SelectBox checked={selection.allSelected} onChange={selection.toggleAll} label={`Select all ${noun}`} />
      <span className="text-muted-foreground">{count > 0 ? `${count} selected` : `${total} ${noun}`}</span>
      {count > 0 && (
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={selection.clear} disabled={busy}>
            Clear
          </Button>
          <Button variant="destructive" size="sm" onClick={onDelete} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete {count}
          </Button>
        </div>
      )}
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
