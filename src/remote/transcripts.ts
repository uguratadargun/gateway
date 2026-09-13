import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * A remote person's Claude Code sessions, as their transcripts on this server.
 *
 * Every remote terminal runs with its person's own CLAUDE_CONFIG_DIR, so
 * `<that dir>/projects/<cwd slug>/<session>.jsonl` is the whole list of what
 * they ever ran here — live or asleep — and `claude --resume <id>` wakes one.
 * Read the way the cockpit reads a desktop's (src/main/transcript.ts there):
 * the title is the first real prompt, the context is the last assistant text.
 */

export interface TranscriptSummary {
  title: string | null;
  lastAssistantText: string | null;
  lastAt: number | null;
  cwd: string | null;
}

const WHOLE_READ_LIMIT = 20 * 1024 * 1024;
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 80;

interface Block {
  type?: string;
  text?: string;
}

interface Line {
  type?: string;
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  message?: { id?: string; content?: string | Block[] };
}

const NOISE_BLOCK = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
const NOISE_START = /^<(command-name|command-message|command-args|local-command-|system-reminder|ide_|bash-input|bash-stdout|bash-stderr)/;

function textOf(content: string | Block[] | undefined): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  return parts.length ? parts.join("\n") : null;
}

function titleOf(line: Line): string | null {
  if (line.isMeta) return null;
  const raw = textOf(line.message?.content);
  if (!raw) return null;
  const cleaned = raw.replace(NOISE_BLOCK, "").trim();
  if (!cleaned || NOISE_START.test(cleaned)) return null;
  const first = cleaned
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return null;
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
}

function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") out.push(o as Line);
    } catch {
      // a torn line
    }
  }
  return out;
}

function readRange(fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString("utf8");
}

function summarize(lines: Line[], head: Line[] | null): TranscriptSummary {
  let lastAt: number | null = null;
  let cwd: string | null = null;
  let groupId: string | null = null;
  let group: string[] = [];
  const findTitle = (src: Line[]): string | null => {
    for (const l of src) {
      if (l.type !== "user") continue;
      const t = titleOf(l);
      if (t) return t;
    }
    return null;
  };
  for (const l of lines) {
    if (l.type !== "user" && l.type !== "assistant") continue;
    if (typeof l.timestamp === "string") {
      const at = Date.parse(l.timestamp);
      if (!Number.isNaN(at)) lastAt = at;
    }
    if (typeof l.cwd === "string" && l.cwd) cwd = l.cwd;
    if (l.type !== "assistant") continue;
    const text = textOf(l.message?.content);
    const id = typeof l.message?.id === "string" ? l.message.id : null;
    if (text && text.trim()) {
      if (id !== null && id === groupId) group.push(text);
      else {
        groupId = id;
        group = [text];
      }
    } else if (id === null || id !== groupId) {
      groupId = null;
    }
  }
  const title = head ? (findTitle(head) ?? findTitle(lines)) : findTitle(lines);
  const lastAssistantText = group.length ? group.join("\n").trim() : null;
  return { title, lastAssistantText: lastAssistantText || null, lastAt, cwd };
}

export function readTranscriptSummary(path: string): TranscriptSummary {
  const empty: TranscriptSummary = { title: null, lastAssistantText: null, lastAt: null, cwd: null };
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, "r");
  } catch {
    return empty;
  }
  try {
    if (size <= WHOLE_READ_LIMIT) return summarize(parseLines(readRange(fd, 0, size)), null);
    const headText = readRange(fd, 0, HEAD_BYTES);
    const head = parseLines(headText.slice(0, headText.lastIndexOf("\n") + 1));
    const tailText = readRange(fd, size - TAIL_BYTES, TAIL_BYTES);
    const tail = parseLines(tailText.slice(tailText.indexOf("\n") + 1));
    return summarize(tail, head);
  } catch {
    return empty;
  } finally {
    closeSync(fd);
  }
}

export interface DiscoveredTranscript {
  id: string;
  path: string;
  cwd: string | null;
  title: string | null;
  startedAt: number;
  lastActiveAt: number;
}

/** The first `cwd` and `timestamp` of a transcript, from its opening bytes only. */
function readHead(path: string): { cwd: string | null; firstAt: number | null } {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const text = readRange(fd, 0, 64 * 1024);
    let cwd: string | null = null;
    let firstAt: number | null = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: { cwd?: unknown; timestamp?: unknown };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (cwd === null && typeof rec.cwd === "string" && rec.cwd) cwd = rec.cwd;
      if (firstAt === null && typeof rec.timestamp === "string") {
        const t = Date.parse(rec.timestamp);
        if (Number.isFinite(t)) firstAt = t;
      }
      if (cwd !== null && firstAt !== null) break;
    }
    return { cwd, firstAt };
  } catch {
    return { cwd: null, firstAt: null };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Every session under a config dir, most recently active first; subagent transcripts are not sessions. */
export function discoverTranscripts(claudeConfigDir: string, limit = 40): DiscoveredTranscript[] {
  const root = join(claudeConfigDir, "projects");
  const found: Array<{ path: string; mtime: number; birth: number }> = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  for (const project of projects) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(root, project, entry);
      try {
        const st = statSync(path);
        if (!st.isFile() || st.size === 0) continue;
        found.push({ path, mtime: st.mtimeMs, birth: st.birthtimeMs || st.ctimeMs || st.mtimeMs });
      } catch {
        // gone between readdir and stat
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map((f) => {
    const head = readHead(f.path);
    const summary = readTranscriptSummary(f.path);
    return {
      id: basename(f.path, ".jsonl"),
      path: f.path,
      cwd: head.cwd ?? summary.cwd,
      title: summary.title,
      startedAt: Math.round(head.firstAt ?? f.birth),
      lastActiveAt: Math.round(Math.max(f.mtime, summary.lastAt ?? 0)),
    };
  });
}
