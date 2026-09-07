"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff, FilePlus2, FileMinus2, FileSymlink } from "lucide-react";

/**
 * A unified diff, rendered the way a code host renders one: a card per file,
 * both line numbers in the gutter, additions and deletions coloured.
 *
 * Parsed here rather than pulled in as a dependency — the format is small and
 * a run's diff is the one thing on this page that has to be trustworthy, so it
 * is worth being able to read exactly what turns text into what you see.
 */

type LineKind = "context" | "add" | "del" | "meta";

interface DiffLine {
  kind: LineKind;
  old: number | null;
  new: number | null;
  text: string;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** A file git described but did not diff — binary, or mode-only. */
  note: string | null;
}

/** Files bigger than this start collapsed; scrolling past 400 lines to reach the next file is not reading. */
const AUTO_COLLAPSE_LINES = 400;

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = () => {
    if (file) files.push(file);
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      pushFile();
      hunk = null;
      // `a/x b/y`, and a path with spaces is why this is not a plain split.
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      const from = m?.[1] ?? "";
      const to = m?.[2] ?? from;
      file = { path: to, oldPath: from === to ? null : from, status: "modified", additions: 0, deletions: 0, hunks: [], note: null };
      continue;
    }
    if (!file) continue;

    if (raw.startsWith("new file mode")) file.status = "added";
    else if (raw.startsWith("deleted file mode")) file.status = "deleted";
    else if (raw.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = raw.slice("rename from ".length);
    } else if (raw.startsWith("rename to ")) file.path = raw.slice("rename to ".length);
    else if (raw.startsWith("Binary files")) file.note = "binary file";

    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      hunk = { header: (m?.[3] ?? "").trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", old: null, new: newNo++, text: raw.slice(1) });
      file.additions++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", old: oldNo++, new: null, text: raw.slice(1) });
      file.deletions++;
    } else if (raw.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", old: null, new: null, text: raw.slice(1).trim() });
    } else if (raw.startsWith(" ") || raw === "") {
      hunk.lines.push({ kind: "context", old: oldNo++, new: newNo++, text: raw.slice(1) });
    }
  }
  pushFile();
  return files;
}

const STATUS_ICON = {
  added: FilePlus2,
  deleted: FileMinus2,
  renamed: FileSymlink,
  modified: FileDiff,
} as const;

const LINE_STYLE: Record<LineKind, string> = {
  add: "bg-emerald-500/10",
  del: "bg-destructive/10",
  context: "",
  meta: "text-muted-foreground italic",
};

const GUTTER_STYLE: Record<LineKind, string> = {
  add: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  del: "bg-destructive/15 text-destructive",
  context: "text-muted-foreground/60",
  meta: "text-muted-foreground/60",
};

function FileDiffCard({ file }: { file: DiffFile }) {
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount <= AUTO_COLLAPSE_LINES);
  const Icon = STATUS_ICON[file.status];

  return (
    <div className="overflow-hidden rounded-md border">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-muted/40 px-2 py-1.5 text-left text-xs hover:bg-muted/70"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">
          {file.oldPath && <span className="text-muted-foreground line-through">{file.oldPath} → </span>}
          {file.path}
        </span>
        {file.status !== "modified" && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{file.status}</span>
        )}
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
          <span className="text-destructive">−{file.deletions}</span>
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto">
          {file.note && <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{file.note}</div>}
          {!file.note && file.hunks.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">no textual changes</div>
          )}
          <table className="w-full border-collapse font-mono text-[11px] leading-[1.55]">
            <tbody>
              {file.hunks.map((h, hi) => (
                <Fragment key={`h${hi}`}>
                  <tr className="bg-muted/30 text-muted-foreground">
                    <td colSpan={3} className="whitespace-pre px-2 py-0.5 text-[10px]">
                      {h.header || "…"}
                    </td>
                  </tr>
                  {h.lines.map((l, li) => (
                    <tr key={`h${hi}l${li}`} className={LINE_STYLE[l.kind]}>
                      <td
                        className={`w-10 select-none border-r px-1.5 text-right align-top tabular-nums ${GUTTER_STYLE[l.kind]}`}
                      >
                        {l.old ?? ""}
                      </td>
                      <td
                        className={`w-10 select-none border-r px-1.5 text-right align-top tabular-nums ${GUTTER_STYLE[l.kind]}`}
                      >
                        {l.new ?? ""}
                      </td>
                      <td className="whitespace-pre px-2 align-top">
                        <span className="select-none text-muted-foreground/70">
                          {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                        </span>
                        {l.text}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const totals = useMemo(
    () => files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }),
    [files],
  );

  if (!files.length) {
    return <p className="px-1 text-xs text-muted-foreground">The worktree has no changes.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <span className="font-mono tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{totals.add}</span>{" "}
          <span className="text-destructive">−{totals.del}</span>
        </span>
        {truncated && <span className="text-amber-600 dark:text-amber-400">· truncated, read it with git for the rest</span>}
      </div>
      {files.map((f) => (
        <FileDiffCard key={f.path} file={f} />
      ))}
    </div>
  );
}
