import { getExecution, sweepAbandonedLocalRuns } from "@/executions/store";
import { getDb } from "@/lib/db";
import { getUser, teamFamily } from "@/lib/teams";

import type { ActivityCard } from "./cards";
import { memoryScopeFor, searchDecisions } from "./store";
import { MERGE_WORKFLOW_ID, TEACH_WORKFLOW_ID, type MemoryScope } from "./types";

/**
 * What the tree is doing right now.
 *
 * Memory is written when a run ends, so until then a run is invisible to
 * every other team: two teams can start the same feature on the same morning
 * and each recall answers "nothing found", truthfully, twice. The runs are
 * already on this server while they go — every one registers when it starts
 * — so the answer to "is anyone building this now" needs no model and no new
 * record: it is the running rows of the tree, matched against the words of
 * the task.
 *
 * Two ways it reaches people. Pulled: recall's search carries the matching
 * in-flight runs, and the brief puts them first. Pushed: when a run starts
 * and a run of another team in the tree is already on work with the same
 * words, the two people get a message, once, where they read gate —
 * Telegram, when the gate has a bot and they have linked it. The match is
 * code: shared words, counted, never a model deciding who should talk.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "are", "was", "were", "have",
  "has", "not", "but", "you", "your", "our", "its", "can", "should", "would", "could", "will", "all", "any", "also",
  "add", "make", "use", "using", "how", "what", "which", "where", "who", "does", "did", "one", "two", "new", "same",
  "fix", "bug", "task", "run", "work", "change", "update", "some", "more", "only", "just", "need", "needs", "like",
  "bir", "ve", "ile", "için", "bu", "şu", "gibi", "olan", "olarak", "daha", "çok", "var", "yok", "ama", "veya",
  "yap", "ekle", "düzelt", "lazım", "gerek", "şey", "her", "kadar", "sonra", "önce",
]);

/**
 * The words that say what a task is about, each cut to its first six letters:
 * a stem that needs no language, so "notifications" meets "notification" and
 * "bildirimleri" meets "bildirim". Cruder than a stemmer, and the same for
 * every language a team writes its tasks in.
 */
export function taskTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw.slice(0, 6));
  }
  return out;
}

/** How much two tasks share: the shared terms, and their share of the shorter task. */
export function overlap(a: Set<string>, b: Set<string>): { shared: string[]; score: number } {
  const shared = [...a].filter((t) => b.has(t));
  const smaller = Math.min(a.size, b.size);
  return { shared, score: smaller ? shared.length / smaller : 0 };
}

/** Close enough to tell a person: several words in common, and a real share of the smaller task. */
export function isOverlap(o: { shared: string[]; score: number }): boolean {
  return o.shared.length >= 3 && o.score >= 0.4;
}

/** Close enough to show a planner, who reads the line and judges it. */
function isRelated(o: { shared: string[]; score: number }): boolean {
  return o.shared.length >= 2 && o.score >= 0.25;
}

function taskOf(input: Record<string, unknown>): string {
  const task = input.task;
  if (typeof task === "string") return task;
  return Object.values(input).filter((v): v is string => typeof v === "string").join(" ");
}

function personOf(userId: string | null): string | null {
  if (!userId) return null;
  const u = getUser(userId);
  return u ? u.name || u.email : null;
}

interface RunningRow {
  id: string;
  workflow_id: string;
  team_id: string | null;
  user_id: string | null;
  input_json: string;
  started_at: number;
  paused_at: number | null;
  repo_id: string | null;
  client_branch: string | null;
  task_id: string | null;
}

function runningIn(teams: string[]): RunningRow[] {
  if (!teams.length) return [];
  sweepAbandonedLocalRuns();
  return getDb()
    .prepare(
      `SELECT id, workflow_id, team_id, user_id, input_json, started_at, paused_at, repo_id, client_branch, task_id
         FROM workflow_executions
        WHERE status = 'running' AND COALESCE(team_id, 'default') IN (${teams.map(() => "?").join(",")})
          AND workflow_id NOT IN (?, ?)
        ORDER BY started_at DESC
        LIMIT 200`,
    )
    .all(...teams, TEACH_WORKFLOW_ID, MERGE_WORKFLOW_ID) as unknown as RunningRow[];
}

function toCard(r: RunningRow, o?: { shared: string[]; score: number }): ActivityCard {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(r.input_json) as Record<string, unknown>;
  } catch {
    // A row with unreadable input still says who is running what.
  }
  return {
    executionId: r.id,
    team: r.team_id ?? "default",
    workflow: r.workflow_id,
    task: taskOf(input).slice(0, 600),
    repo: r.repo_id,
    branch: r.client_branch,
    person: personOf(r.user_id),
    status: r.paused_at ? "paused" : "running",
    startedAt: new Date(Number(r.started_at)).toISOString(),
    taskId: r.task_id,
    shared: o?.shared ?? [],
  };
}

/**
 * The tree's runs going right now. With a query, only the ones whose task
 * shares enough of its words, best first; without, all of them, newest first.
 * The asker's own run, and the asking person's other runs, are never in the answer.
 */
export function inFlight(
  scope: MemoryScope,
  opts: { query?: string; excludeExecution?: string | null; excludeUserId?: string | null; limit?: number } = {},
): ActivityCard[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  // A person's own runs are theirs to know about, not somebody else's work to
  // coordinate with — and the run asking would otherwise find itself first.
  const rows = runningIn(scope.teams).filter((r) => r.id !== opts.excludeExecution && (!opts.excludeUserId || r.user_id !== opts.excludeUserId));
  if (!opts.query?.trim()) return rows.slice(0, limit).map((r) => toCard(r));
  const q = taskTerms(opts.query);
  return rows
    .map((r) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(r.input_json) as Record<string, unknown>;
      } catch {
        // skipped below: nothing to match
      }
      return { r, o: overlap(q, taskTerms(taskOf(input))) };
    })
    .filter(({ o }) => isRelated(o))
    .sort((a, b) => b.o.score - a.o.score || b.o.shared.length - a.o.shared.length)
    .slice(0, limit)
    .map(({ r, o }) => toCard(r, o));
}

// ── Telling people ───────────────────────────────────────────────────────────

const g = globalThis as unknown as { __gateOverlapTold?: Set<string> };

function told(): Set<string> {
  g.__gateOverlapTold ??= new Set();
  return g.__gateOverlapTold;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function firstLine(s: string, max = 160): string {
  const line = s.split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface OverlapNotice {
  /** The run that just started. */
  executionId: string;
  /** Another team's run already going, or another team's unfinished taught work. */
  other: { kind: "run" | "decision"; id: string; team: string; title: string; person: string | null };
  shared: string[];
}

/**
 * What a run that just started has in common with the rest of the tree:
 * another team's run on the same words, or another team's work recorded as
 * still in progress. Pure lookup; `announceOverlap` is what tells anyone.
 */
export function overlapsOf(executionId: string): OverlapNotice[] {
  const run = getExecution(executionId);
  if (!run || run.workflowId === TEACH_WORKFLOW_ID || run.workflowId === MERGE_WORKFLOW_ID) return [];
  const task = taskOf(run.input);
  const terms = taskTerms(task);
  if (terms.size < 3) return [];
  const family = teamFamily(run.teamId);
  const out: OverlapNotice[] = [];
  for (const r of runningIn(family)) {
    if (r.id === executionId || (r.team_id ?? "default") === run.teamId) continue;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(r.input_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const o = overlap(terms, taskTerms(taskOf(input)));
    if (isOverlap(o)) {
      out.push({ executionId, other: { kind: "run", id: r.id, team: r.team_id ?? "default", title: firstLine(taskOf(input)), person: personOf(r.user_id) }, shared: o.shared });
    }
  }
  // Taught work another team says is not finished: the one moment an
  // objection is cheap for both sides.
  for (const d of searchDecisions(memoryScopeFor(run.teamId), { query: task, limit: 20 })) {
    if (d.outcome !== "in-progress" || d.teamId === run.teamId || d.validTo != null) continue;
    const o = overlap(terms, taskTerms(`${d.title} ${d.decision}`));
    if (isOverlap(o)) out.push({ executionId, other: { kind: "decision", id: d.id, team: d.teamId, title: d.title, person: null }, shared: o.shared });
  }
  return out;
}

/** The chats of the people to tell: each run's own person, else everyone linked on its team. */
async function chatsFor(people: Array<{ userId: string | null; teamId: string }>): Promise<string[]> {
  const { listLinks } = await import("@/telegram/store");
  const links = listLinks();
  const chats = new Set<string>();
  for (const p of people) {
    const mine = p.userId ? links.filter((l) => l.userId === p.userId) : links.filter((l) => l.teamId === p.teamId);
    for (const l of mine) chats.add(l.chatId);
  }
  return [...chats];
}

/**
 * Tells the people on both sides of an overlap, once per pair. Fire and
 * forget: a run never waits for this, and a gate without a bot simply has
 * nobody to push to — recall still shows it.
 */
export async function announceOverlap(executionId: string): Promise<OverlapNotice[]> {
  const notices = overlapsOf(executionId).filter((n) => {
    const key = [n.executionId, n.other.id].sort().join("|");
    if (told().has(key)) return false;
    told().add(key);
    return true;
  });
  if (!notices.length) return notices;
  const { telegramBot } = await import("@/telegram/runtime");
  const bot = telegramBot();
  if (!bot) return notices;
  const run = getExecution(executionId);
  if (!run) return notices;
  const starter = personOf(run.userId) ?? run.teamId;
  for (const n of notices) {
    const otherRun = n.other.kind === "run" ? getExecution(n.other.id) : null;
    const text =
      `⚠ <b>Same work, two teams</b>\n` +
      `${esc(starter)} (${esc(run.teamId)}) just started: <i>${esc(firstLine(taskOf(run.input)))}</i> · run ${run.id.slice(0, 8)}\n` +
      (n.other.kind === "run"
        ? `${esc(n.other.person ?? n.other.team)} (${esc(n.other.team)}) is already running: <i>${esc(n.other.title)}</i> · run ${n.other.id.slice(0, 8)}\n`
        : `${esc(n.other.team)} taught this as unfinished: <i>${esc(n.other.title)}</i> · ${n.other.id}\n`) +
      `In common: ${esc(n.shared.slice(0, 8).join(", "))}\n` +
      `Talk before both of you build it.`;
    const people = [{ userId: run.userId, teamId: run.teamId }];
    if (otherRun) people.push({ userId: otherRun.userId, teamId: otherRun.teamId });
    else people.push({ userId: null, teamId: n.other.team });
    for (const chat of await chatsFor(people)) {
      await bot.notify(chat, text).catch(() => undefined);
    }
  }
  return notices;
}

/** Started from a route handler or the runner: never awaited, never throws. */
export function scheduleOverlapCheck(executionId: string): void {
  setImmediate(() => {
    announceOverlap(executionId).catch((e) => console.error("[gate] overlap check:", e));
  });
}
