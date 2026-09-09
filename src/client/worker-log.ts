import { relative } from "node:path";

import type { ToolCallRecord } from "@/runtime/state";

/**
 * The worker's log, as the person following a run reads it.
 *
 * A claude-code node runs out of sight, and this log is the session's only
 * window on it. It is written the way Claude Code itself shows a node's
 * activity in a terminal: one short line per thing done — the file read,
 * the file edited and by how much, the command run — and the agent's own
 * words between them. No timestamps, no diffs, no output: the dashboard has
 * the detail, and a terminal wants a glance.
 */

/** Longest line kept. */
const LINE_WIDTH = 120;
/** Lines of the agent's own narration kept per message. */
const TEXT_LINES = 3;

function clip(s: string, width = LINE_WIDTH): string {
  const line = s.trim().replace(/\s+/g, " ");
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

function firstLine(s: string): string {
  return clip(s.split("\n").find((l) => l.trim()) ?? "", 80);
}

function field(input: unknown, key: string): string | null {
  const v = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : null;
}

/** A path as the person knows it: relative to the worktree when it is inside it. */
function pathOf(p: string | null, root: string): string {
  if (!p) return "?";
  if (root && (p === root || p.startsWith(`${root}/`))) return relative(root, p) || ".";
  return p;
}

function lineCount(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

/** What one call did, in the words Claude Code would use for it. */
function summary(call: ToolCallRecord, root: string): string {
  const input = call.input;
  const file = pathOf(field(input, "file_path") ?? field(input, "path"), root);
  switch (call.tool) {
    case "Read":
      return `Read ${file}`;
    case "Edit":
    case "MultiEdit": {
      const removed = lineCount(field(input, "old_string") ?? "");
      const added = lineCount(field(input, "new_string") ?? "");
      return `Edit ${file} (+${added} −${removed})`;
    }
    case "Write":
      return `Write ${file} (${lineCount(field(input, "content") ?? "")} lines)`;
    case "Bash":
      return `Bash: ${clip(field(input, "description") ?? field(input, "command") ?? "", 100)}`;
    case "Grep":
      return `Grep ${JSON.stringify(field(input, "pattern") ?? "")}${field(input, "path") ? ` in ${pathOf(field(input, "path"), root)}` : ""}`;
    case "Glob":
      return `Glob ${field(input, "pattern") ?? ""}${field(input, "path") ? ` in ${pathOf(field(input, "path"), root)}` : ""}`;
    case "Task":
    case "Agent":
      return `Agent: ${clip(field(input, "description") ?? "", 100)}`;
    case "Skill":
      return `Skill ${field(input, "skill") ?? field(input, "name") ?? "?"}`;
    case "TodoWrite":
      return "Update todos";
    case "WebFetch":
    case "WebSearch":
      return `${call.tool} ${clip(field(input, "url") ?? field(input, "query") ?? "", 100)}`;
    default:
      return call.tool;
  }
}

/**
 * One tool call, on one line. A refused or failed call keeps the first line
 * of what came back, because that is the one time the output is the point.
 */
export function describeCall(call: ToolCallRecord, root = ""): string {
  const line = summary(call, root);
  return call.ok ? `⏺ ${line}\n` : `⏺ ${line} — ${firstLine(call.result) || "failed"}\n`;
}

/**
 * What the agent said between calls — the "I'll start with the tests" that
 * explains the next few lines. A few lines at most; a message that is only
 * whitespace is nothing.
 */
export function describeText(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const shown = lines.slice(0, TEXT_LINES).map((l, i) => `${i === 0 ? "⏺ " : "  "}${clip(l)}`);
  if (lines.length > TEXT_LINES) shown.push("  …");
  return `${shown.join("\n")}\n`;
}
