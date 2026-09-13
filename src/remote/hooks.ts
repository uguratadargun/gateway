import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import { readTranscriptSummary } from "./transcripts";
import type {
  AskAnswer,
  PermissionDecision,
  Question,
  RemotePending,
  RemotePendingAsk,
  RemotePendingPermission,
  RemoteRunPointer,
  RemoteStatus,
} from "./types";

/**
 * The server's end of the remote sessions' hook socket.
 *
 * Every hook of every remote terminal connects here with one NDJSON frame,
 * `{v:1, terminal, token, payload}`, and waits for one JSON line back. A frame
 * whose token is not its terminal's is dropped: the socket is the gate user's
 * alone (0600), and the token keeps one session from answering for another.
 * Most events are answered `{}` at once and only reported; the two a person
 * has to settle are held open until they do, from a cockpit anywhere.
 *
 * Ported from the cockpit's HookServer, so a question looks the same whether
 * the session asking it runs on the desktop or here.
 */

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: unknown;
  notification_type?: string;
  message?: string;
  permission_suggestions?: unknown;
  hook_role?: string;
}

export interface HookEvent {
  terminal: string;
  sessionId: string;
  cwd: string;
  at: number;
  /** What the session is doing now, when the event says. */
  status: RemoteStatus | null;
}

/** The terminal a hook frame claims, and what it must know to be believed. */
export interface TerminalIdentity {
  token: string;
  repo: string | null;
  /** Where that terminal's `gate` CLI writes its run pointers. */
  readRun: (sessionId: string) => RemoteRunPointer | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstLine(s: string | undefined, max = 200): string | undefined {
  const line = (s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The status a hook event means, or null for events that say nothing about it. */
export function statusForHook(p: HookPayload): RemoteStatus | null {
  switch (p.hook_event_name) {
    case "SessionStart":
    case "Stop":
      // A session that has just started is at its prompt; work begins with the first prompt.
      return "idle";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "working";
    case "SessionEnd":
      return "exited";
    case "Notification": {
      const t = p.notification_type ?? "";
      if (t === "permission_prompt") return "blocked";
      if (t === "idle_prompt" || t === "idle" || t === "agent_needs_input") return "waiting";
      if (!t && /waiting for your input/i.test(p.message ?? "")) return "waiting";
      return null;
    }
    default:
      return null;
  }
}

export function questionsOf(input: unknown): Question[] {
  if (!isRecord(input) || !Array.isArray(input.questions)) return [];
  return input.questions.filter(isRecord).map((q) => ({
    question: typeof q.question === "string" ? q.question : "",
    header: typeof q.header === "string" ? q.header : "",
    multiSelect: q.multiSelect === true,
    options: Array.isArray(q.options)
      ? q.options.filter(isRecord).map((o) => ({
          label: typeof o.label === "string" ? o.label : "",
          description: typeof o.description === "string" ? o.description : "",
        }))
      : [],
  }));
}

export function permissionSummary(toolName: string, input: Record<string, unknown>): string {
  const str = (k: string): string | undefined => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  switch (toolName) {
    case "Bash":
      return firstLine(str("command")) ?? toolName;
    case "Edit":
    case "Write":
    case "MultiEdit":
      return str("file_path") ?? toolName;
    case "NotebookEdit":
      return str("notebook_path") ?? str("file_path") ?? toolName;
    case "ExitPlanMode": {
      const line = firstLine(str("plan")?.replace(/^\s*#+\s*/gm, ""), 120);
      return line ? `Approve the plan: ${line}` : "Approve the plan";
    }
    default:
      return toolName;
  }
}

/** The reply that answers a held AskUserQuestion; its questions are echoed exactly as received. */
export function askReply(toolInput: unknown, answer: AskAnswer): unknown {
  const questions = isRecord(toolInput) ? toolInput.questions : undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        questions,
        answers: answer.answers ?? {},
        ...(answer.response ? { response: answer.response } : {}),
      },
    },
  };
}

export function permissionReply(p: RemotePendingPermission, decision: PermissionDecision): unknown {
  const d =
    decision.behavior === "allow"
      ? {
          behavior: "allow",
          updatedInput: p.toolInput,
          ...(decision.always && p.suggestions.length ? { updatedPermissions: p.suggestions } : {}),
        }
      : { behavior: "deny", message: decision.message };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } };
}

interface Held {
  pending: RemotePending;
  terminal: string;
  conn: Socket;
  toolInput: unknown;
}

const isPipe = (p: string): boolean => p.startsWith("\\\\.\\pipe\\");
const MAX_FRAME = 4 * 1024 * 1024;

export class HookHub {
  private server: Server | null = null;
  private path: string | null = null;
  private held = new Map<string, Held>();

  constructor(
    private readonly identify: (terminal: string) => TerminalIdentity | null,
    private readonly onEvent: (e: HookEvent) => void,
    private readonly onPendingChange: () => void,
  ) {}

  get sockPath(): string | null {
    return this.path;
  }

  async start(sockPath: string): Promise<void> {
    if (this.server) return;
    if (!isPipe(sockPath)) {
      try {
        if (existsSync(sockPath)) rmSync(sockPath);
      } catch {
        // a stale socket that cannot go: listen reports it
      }
    }
    const server = createServer((conn) => this.accept(conn));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (e) => console.error("[gate] remote hook socket error:", e));
    if (!isPipe(sockPath)) {
      try {
        chmodSync(sockPath, 0o600);
      } catch {
        // best effort
      }
    }
    // Not what keeps the process alive: that is the web server's job.
    server.unref();
    this.server = server;
    this.path = sockPath;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const h of this.held.values()) h.conn.destroy();
    this.held.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.path && !isPipe(this.path)) rmSync(this.path, { force: true });
    this.path = null;
  }

  pending(): RemotePending[] {
    return [...this.held.values()].map((h) => h.pending);
  }

  /** The terminal a pending item belongs to, for the ownership check. */
  terminalOf(id: string): string | null {
    return this.held.get(id)?.terminal ?? null;
  }

  answer(id: string, answer: AskAnswer): { ok: true } | { ok: false; status: number; error: string } {
    const h = this.held.get(id);
    if (!h) return { ok: false, status: 404, error: `no pending question ${id}` };
    if (h.pending.kind === "permission") return { ok: false, status: 400, error: `${id} is a permission, not a question` };
    this.settle(id, askReply(h.toolInput, answer));
    return { ok: true };
  }

  decide(id: string, decision: PermissionDecision): { ok: true } | { ok: false; status: number; error: string } {
    const h = this.held.get(id);
    if (!h) return { ok: false, status: 404, error: `no pending permission ${id}` };
    if (h.pending.kind !== "permission") return { ok: false, status: 400, error: `${id} is a question, not a permission` };
    this.settle(id, permissionReply(h.pending, decision));
    return { ok: true };
  }

  /** A terminal that is gone takes its held prompts with it. */
  dropTerminal(terminal: string): void {
    let changed = false;
    for (const [id, h] of this.held) {
      if (h.terminal !== terminal) continue;
      this.held.delete(id);
      h.conn.destroy();
      changed = true;
    }
    if (changed) this.onPendingChange();
  }

  private accept(conn: Socket): void {
    let buf = "";
    let taken = false;
    conn.setEncoding("utf8");
    conn.on("error", () => {
      // the shim hung up
    });
    conn.on("data", (d: string) => {
      if (taken) return;
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl === -1) {
        if (buf.length > MAX_FRAME) conn.destroy();
        return;
      }
      taken = true;
      let frame: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(buf.slice(0, nl));
        if (isRecord(parsed) && isRecord(parsed.payload)) frame = parsed;
      } catch {
        frame = null;
      }
      const terminal = typeof frame?.terminal === "string" ? frame.terminal : null;
      const identity = terminal ? this.identify(terminal) : null;
      if (!frame || !terminal || !identity || frame.token !== identity.token) {
        conn.end();
        return;
      }
      try {
        this.handle(terminal, identity, frame.payload as HookPayload, conn);
      } catch (e) {
        console.error("[gate] remote hook handling failed:", e);
        this.reply(conn, {});
      }
    });
  }

  private reply(conn: Socket, res: unknown): void {
    try {
      conn.end(`${JSON.stringify(res ?? {})}\n`);
    } catch {
      conn.destroy();
    }
  }

  private handle(terminal: string, identity: TerminalIdentity, p: HookPayload, conn: Socket): void {
    if (p.session_id) {
      this.onEvent({ terminal, sessionId: p.session_id, cwd: p.cwd ?? "", at: Date.now(), status: statusForHook(p) });
    }

    const holdsAsk = p.hook_event_name === "PreToolUse" && p.tool_name === "AskUserQuestion" && p.hook_role !== "status";
    const holdsPermission = p.hook_event_name === "PermissionRequest";
    if ((!holdsAsk && !holdsPermission) || !p.session_id) {
      this.reply(conn, {});
      return;
    }

    const id = randomBytes(8).toString("hex");
    const run = identity.readRun(p.session_id);
    const base = {
      id,
      sessionId: p.session_id,
      handle: terminal,
      repo: identity.repo,
      executionId: run?.executionId ?? null,
      nodeId: run?.nodeId ?? null,
      cwd: p.cwd ?? "",
      askedAt: Date.now(),
    };
    let pending: RemotePending;
    if (holdsAsk) {
      const ask: RemotePendingAsk = {
        ...base,
        kind: run?.asks === "approval" ? "approval" : "question",
        questions: questionsOf(p.tool_input),
        context: p.transcript_path ? readTranscriptSummary(p.transcript_path).lastAssistantText : null,
      };
      pending = ask;
    } else {
      const toolInput = isRecord(p.tool_input) ? p.tool_input : {};
      const toolName = p.tool_name ?? "";
      const perm: RemotePendingPermission = {
        ...base,
        kind: "permission",
        toolName,
        toolInput,
        summary: permissionSummary(toolName, toolInput),
        suggestions: Array.isArray(p.permission_suggestions) ? p.permission_suggestions.filter(isRecord) : [],
      };
      pending = perm;
    }

    this.held.set(id, { pending, terminal, conn, toolInput: p.tool_input });
    conn.on("close", () => {
      if (this.held.get(id)?.conn === conn) {
        this.held.delete(id);
        this.onPendingChange();
      }
    });
    this.onPendingChange();
  }

  private settle(id: string, res: unknown): void {
    const h = this.held.get(id);
    if (!h) return;
    this.held.delete(id);
    this.reply(h.conn, res);
    this.onPendingChange();
  }
}
