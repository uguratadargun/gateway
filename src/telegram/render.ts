import type { Question, RemotePendingAsk, RemotePendingPermission, RemoteSession } from "@/remote/types";

import type { Keyboard } from "./api";

/**
 * What the bot says, and what its buttons mean — no I/O, so the whole of it is
 * testable as strings.
 *
 * A question reads the way the cockpit's form does: the context the session
 * gave, each question with its options, and the picks so far. The buttons
 * walk the questions one at a time; a single question with a single answer is
 * sent the moment it is tapped, as a click on a cockpit option is.
 */

/** Telegram's limit on a message is 4096 characters; the rest is headroom for tags. */
const MESSAGE_MAX = 3900;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// -------------------------------------------------------------- answers

export interface Pick {
  labels: string[];
  /** What the person typed through Other, if they did. */
  other: string | null;
}

export interface AskDraft {
  picks: Pick[];
  /** The question the buttons are on; past the last one, the Submit row. */
  cursor: number;
}

export function newDraft(questions: Question[]): AskDraft {
  return { picks: questions.map(() => ({ labels: [], other: null })), cursor: 0 };
}

/** One question's answer, exactly as the cockpit's form builds it. */
export function answerFor(q: Question, pick: Pick | undefined): string | string[] | null {
  if (!pick) return null;
  const typed = pick.other?.trim() ?? "";
  if (q.multiSelect) {
    const all = typed ? [...pick.labels, typed] : pick.labels;
    return all.length ? all : null;
  }
  if (typed) return typed;
  return pick.labels[0] ?? null;
}

export function answersFor(questions: Question[], draft: AskDraft): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  questions.forEach((q, i) => {
    const a = answerFor(q, draft.picks[i]);
    if (a !== null) out[q.question] = a;
  });
  return out;
}

// ------------------------------------------------------------ callbacks

export type Callback =
  | { kind: "pick"; id: string; q: number; o: number }
  | { kind: "other"; id: string; q: number }
  | { kind: "next"; id: string; q: number }
  | { kind: "submit"; id: string }
  | { kind: "restart"; id: string }
  | { kind: "perm"; id: string; decision: "allow" | "always" | "deny" }
  | { kind: "repo"; i: number }
  /** null: let the run pick its own workflow. */
  | { kind: "workflow"; i: number | null }
  | { kind: "close"; handle: string };

/** Button payloads; Telegram allows 64 bytes, so ids go in and names stay in the bot's memory. */
export const cb = {
  pick: (id: string, q: number, o: number) => `q:${id}:${q}:${o}`,
  other: (id: string, q: number) => `x:${id}:${q}`,
  next: (id: string, q: number) => `n:${id}:${q}`,
  submit: (id: string) => `s:${id}`,
  restart: (id: string) => `r:${id}`,
  perm: (id: string, d: "allow" | "always" | "deny") => `p:${id}:${d === "allow" ? "a" : d === "always" ? "A" : "d"}`,
  repo: (i: number) => `R:${i}`,
  workflow: (i: number | null) => `W:${i ?? "-"}`,
  close: (handle: string) => `c:${handle}`,
};

const ID = "([0-9a-f]{1,32})";
const N = "(\\d{1,3})";

export function parseCallback(data: string | undefined): Callback | null {
  if (!data) return null;
  let m: RegExpMatchArray | null;
  if ((m = data.match(new RegExp(`^q:${ID}:${N}:${N}$`)))) return { kind: "pick", id: m[1], q: Number(m[2]), o: Number(m[3]) };
  if ((m = data.match(new RegExp(`^x:${ID}:${N}$`)))) return { kind: "other", id: m[1], q: Number(m[2]) };
  if ((m = data.match(new RegExp(`^n:${ID}:${N}$`)))) return { kind: "next", id: m[1], q: Number(m[2]) };
  if ((m = data.match(new RegExp(`^s:${ID}$`)))) return { kind: "submit", id: m[1] };
  if ((m = data.match(new RegExp(`^r:${ID}$`)))) return { kind: "restart", id: m[1] };
  if ((m = data.match(new RegExp(`^p:${ID}:([aAd])$`)))) {
    return { kind: "perm", id: m[1], decision: m[2] === "a" ? "allow" : m[2] === "A" ? "always" : "deny" };
  }
  if ((m = data.match(new RegExp(`^R:${N}$`)))) return { kind: "repo", i: Number(m[1]) };
  if ((m = data.match(new RegExp(`^W:(${N.slice(1, -1)}|-)$`)))) return { kind: "workflow", i: m[1] === "-" ? null : Number(m[1]) };
  if ((m = data.match(new RegExp(`^c:${ID}$`)))) return { kind: "close", handle: m[1] };
  return null;
}

// ------------------------------------------------------------- messages

function whereOf(p: { repo: string | null; nodeId: string | null; executionId: string | null }): string | null {
  const parts = [p.repo, p.nodeId ? `node ${p.nodeId}` : null, p.executionId ? `run ${p.executionId.slice(0, 8)}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const ASK_HINT = "<i>Reply to this message to send a note instead.</i>";
const PERMISSION_HINT = "<i>Reply to this message to deny it with a reason.</i>";

function askBody(p: RemotePendingAsk, draft: AskDraft, compact: boolean): string[] {
  const lines: string[] = [p.kind === "approval" ? "🟠 <b>Approval needed</b>" : "❓ <b>Question</b>"];
  const where = whereOf(p);
  if (where) lines.push(`<i>${esc(where)}</i>`);
  if (p.context?.trim() && !compact) lines.push(`<blockquote expandable>${esc(clip(p.context.trim(), 1500))}</blockquote>`);
  p.questions.forEach((q, i) => {
    lines.push("");
    const count = p.questions.length > 1 ? `${i + 1}/${p.questions.length} · ` : "";
    lines.push(`${count}<b>${esc(q.header || "Question")}</b>${q.multiSelect ? " <i>(pick any)</i>" : ""}`);
    lines.push(esc(clip(q.question, compact ? 300 : 800)));
    for (const o of q.options) {
      const desc = o.description && !compact ? ` — ${esc(clip(o.description, 200))}` : "";
      lines.push(`• <b>${esc(clip(o.label, 80))}</b>${desc}`);
    }
    const a = answerFor(q, draft.picks[i]);
    if (a !== null) lines.push(`→ <b>${esc(clip(Array.isArray(a) ? a.join(", ") : a, 300))}</b>`);
  });
  return lines;
}

/** A held question. `footer` replaces the reply hint, once the question is settled. */
export function askText(p: RemotePendingAsk, draft: AskDraft, footer: string = ASK_HINT): string {
  for (const compact of [false, true]) {
    const text = [...askBody(p, draft, compact), "", footer].join("\n");
    if (text.length <= MESSAGE_MAX || compact) return text.length <= MESSAGE_MAX ? text : `${text.slice(0, MESSAGE_MAX)}…`;
  }
  return footer;
}

export function askKeyboard(p: RemotePendingAsk, draft: AskDraft): Keyboard {
  const qi = draft.cursor;
  const q = p.questions[qi];
  if (!q) {
    return [
      [
        { text: "✅ Submit", callback_data: cb.submit(p.id) },
        { text: "↺ Start over", callback_data: cb.restart(p.id) },
      ],
    ];
  }
  const pick = draft.picks[qi];
  const rows: Keyboard = q.options.map((o, oi) => {
    const mark = q.multiSelect ? (pick.labels.includes(o.label) ? "☑️ " : "⬜️ ") : "";
    return [{ text: clip(`${mark}${o.label}`, 60), callback_data: cb.pick(p.id, qi, oi) }];
  });
  const last = [{ text: pick.other ? `✏️ ${clip(pick.other, 30)}` : "✏️ Other…", callback_data: cb.other(p.id, qi) }];
  if (q.multiSelect) last.push({ text: "Next ▶️", callback_data: cb.next(p.id, qi) });
  rows.push(last);
  return rows;
}

function permissionDetail(p: RemotePendingPermission): string | null {
  const input = p.toolInput;
  if (p.toolName === "Bash" && typeof input.command === "string") return `<pre>${esc(clip(input.command, 2000))}</pre>`;
  if (p.toolName === "ExitPlanMode" && typeof input.plan === "string") {
    return `<blockquote expandable>${esc(clip(input.plan, 3000))}</blockquote>`;
  }
  const keys = Object.keys(input);
  if (!keys.length) return null;
  let json = "";
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    return null;
  }
  return `<pre>${esc(clip(json, 1200))}</pre>`;
}

export function permissionText(p: RemotePendingPermission, footer: string = PERMISSION_HINT): string {
  const lines = [`🔐 <b>Permission</b> · ${esc(p.toolName || "tool")}`];
  const where = whereOf(p);
  if (where) lines.push(`<i>${esc(where)}</i>`);
  lines.push(esc(clip(p.summary, 300)));
  const detail = permissionDetail(p);
  if (detail) lines.push(detail);
  lines.push("", footer);
  const text = lines.join("\n");
  return text.length <= MESSAGE_MAX ? text : [lines[0], esc(clip(p.summary, 300)), "", footer].join("\n");
}

export function permissionKeyboard(p: RemotePendingPermission): Keyboard {
  const row = [{ text: "✅ Allow", callback_data: cb.perm(p.id, "allow") }];
  if (p.suggestions.length) row.push({ text: "✅ Always", callback_data: cb.perm(p.id, "always") });
  row.push({ text: "⛔ Deny", callback_data: cb.perm(p.id, "deny") });
  return [row];
}

export function settledFooter(outcome: string): string {
  return `<b>${esc(outcome)}</b>`;
}

export type RunEvent =
  | { type: "workflow.started" }
  | { type: "workflow.completed"; status: "completed" | "failed" }
  | { type: "workflow.failed"; message: string };

export function runEventText(e: RunEvent, run: { id: string; workflowId: string; input: Record<string, unknown> }): string {
  const task = typeof run.input.task === "string" && run.input.task.trim() ? `\n<i>${esc(clip(run.input.task.trim(), 300))}</i>` : "";
  const name = `<b>${esc(run.workflowId)}</b> · <code>${esc(run.id.slice(0, 8))}</code>`;
  if (e.type === "workflow.started") return `▶️ Run started · ${name}${task}`;
  if (e.type === "workflow.completed" && e.status === "completed") return `✅ Run finished · ${name}${task}`;
  const why = e.type === "workflow.failed" && e.message ? `\n${esc(clip(e.message, 500))}` : "";
  return `❌ Run failed · ${name}${task}${why}`;
}

const STATUS_MARK: Record<RemoteSession["status"], string> = {
  working: "⚙️",
  idle: "💤",
  waiting: "❓",
  blocked: "🔐",
  exited: "⏹",
};

export function sessionsText(sessions: RemoteSession[]): string {
  if (!sessions.length) return "No live sessions on the gate. /run starts one.";
  const lines = ["<b>Live sessions</b>"];
  for (const s of sessions) {
    const run = s.run ? ` · ${esc(s.run.state)}${s.run.nodeId ? ` at ${esc(s.run.nodeId)}` : ""}` : "";
    lines.push(`${STATUS_MARK[s.status]} <b>${esc(s.repo ?? s.cwd)}</b> — ${esc(s.status)}${run}`);
    if (s.title) lines.push(`   ${esc(clip(s.title, 120))}`);
  }
  return lines.join("\n");
}

export function sessionsKeyboard(sessions: RemoteSession[]): Keyboard {
  return sessions
    .filter((s): s is RemoteSession & { handle: string } => !!s.handle)
    .slice(0, 20)
    .map((s) => [{ text: clip(`✖ Close ${s.repo ?? s.handle}${s.title ? ` — ${s.title}` : ""}`, 60), callback_data: cb.close(s.handle) }]);
}
