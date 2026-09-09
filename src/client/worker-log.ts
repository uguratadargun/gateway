import { relative } from "node:path";

import type { ToolCallRecord } from "@/runtime/state";

/**
 * The worker's log, as the person following a run reads it.
 *
 * A claude-code node runs out of sight — in its own process, in its own model
 * — and the only window on it from the session is this log. The dashboard
 * gets the same calls as events; here they have to read in a terminal, so a
 * call is written the way the person would have seen it had the node run in
 * front of them: the file it read, the change it made, the command it ran,
 * and what it said it was doing in between.
 */

/** Lines of an edit shown before the rest is folded. */
const DIFF_LINES = 12;
/** Longest line kept; a minified file or a wall of output is not the point. */
const LINE_WIDTH = 200;
/** Lines of the agent's own narration kept per message. */
const TEXT_LINES = 6;

function stamp(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

function clip(s: string, width = LINE_WIDTH): string {
  const line = s.replace(/\s+$/, "");
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

function firstLine(s: string): string {
  return clip((s.split("\n").find((l) => l.trim()) ?? "").trim());
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function field(input: unknown, key: string): string | null {
  return input && typeof input === "object" ? str((input as Record<string, unknown>)[key]) : null;
}

/** A path as the person knows it: relative to the worktree when it is inside it. */
function pathOf(p: string | null, root: string): string {
  if (!p) return "?";
  if (root && (p === root || p.startsWith(`${root}/`))) return relative(root, p) || ".";
  return p;
}

/** `- old` / `+ new` lines of an edit, folded past DIFF_LINES on each side. */
function diffLines(oldText: string, newText: string): string[] {
  const side = (prefix: string, text: string): string[] => {
    const lines = text === "" ? [] : text.split("\n");
    const shown = lines.slice(0, DIFF_LINES).map((l) => `${prefix} ${clip(l)}`);
    if (lines.length > DIFF_LINES) shown.push(`${prefix} … ${lines.length - DIFF_LINES} more lines`);
    return shown;
  };
  return [...side("-", oldText), ...side("+", newText)];
}

/**
 * One tool call, on one line — or a few, when what it did is worth seeing
 * (an edit is shown as the change it made). `root` is the worktree, so paths
 * read the way they do in the repository.
 */
export function describeCall(call: ToolCallRecord, root = ""): string {
  const at = stamp(call.startedAt);
  const mark = call.ok ? " " : "✗";
  const input = call.input;
  const result = firstLine(call.result);
  const head = (what: string, outcome = result) =>
    `${at} ${mark} ${what}${outcome ? ` → ${outcome}` : ""}\n`;
  const file = pathOf(field(input, "file_path") ?? field(input, "path"), root);

  switch (call.tool) {
    case "Read":
      return head(`Read ${file}`);
    case "Edit":
    case "MultiEdit": {
      const oldText = field(input, "old_string") ?? "";
      const newText = field(input, "new_string") ?? "";
      const body = call.ok ? diffLines(oldText, newText) : [];
      const lines = [`${at} ${mark} Edit ${file}${call.ok ? "" : ` → ${result}`}`, ...body.map((l) => `           ${l}`)];
      return `${lines.join("\n")}\n`;
    }
    case "Write": {
      const content = field(input, "content") ?? "";
      const count = content === "" ? 0 : content.split("\n").length;
      return head(`Write ${file} (${count} ${count === 1 ? "line" : "lines"})`, call.ok ? "" : result);
    }
    case "Bash": {
      const command = field(input, "command") ?? "";
      return head(`$ ${clip(command.replace(/\n/g, " ; "))}`);
    }
    case "Grep": {
      const pattern = field(input, "pattern") ?? "";
      const where = field(input, "path") ? ` in ${pathOf(field(input, "path"), root)}` : "";
      return head(`Grep ${JSON.stringify(pattern)}${where}`);
    }
    case "Glob": {
      const pattern = field(input, "pattern") ?? "";
      const where = field(input, "path") ? ` in ${pathOf(field(input, "path"), root)}` : "";
      return head(`Glob ${pattern}${where}`);
    }
    case "Task":
    case "Agent": {
      const description = field(input, "description") ?? "";
      const kind = field(input, "subagent_type");
      return head(`Agent${kind ? ` (${kind})` : ""} ${JSON.stringify(description)}`);
    }
    case "Skill":
      return head(`Skill ${field(input, "skill") ?? field(input, "name") ?? "?"}`);
    case "TodoWrite":
      return head("Todo updated", "");
    default: {
      const json = JSON.stringify(input ?? {});
      return head(`${call.tool} ${clip(json, 140)}`);
    }
  }
}

/**
 * What the agent said between calls — the "I'll start with the tests" that
 * explains the next ten lines. Folded past TEXT_LINES; a message that is only
 * whitespace is nothing.
 */
export function describeText(text: string, at = Date.now()): string {
  const lines = text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  if (!lines.length) return "";
  const shown = lines.slice(0, TEXT_LINES).map((l, i) => `${i === 0 ? `${stamp(at)} » ` : "           » "}${clip(l)}`);
  if (lines.length > TEXT_LINES) shown.push(`           » … ${lines.length - TEXT_LINES} more lines`);
  return `${shown.join("\n")}\n`;
}
