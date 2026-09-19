import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { getExecution } from "@/executions/store";
import type { Principal } from "@/lib/apikeys";
import { getRepo, listRepos } from "@/repos/store";

import { changedFilesIn, fileDiffIn } from "./changes";
import { HookHub, type HookEvent } from "./hooks";
import { loadPty, type PtyProcess } from "./pty";
import { ensureShim, hookSocketPath, SHIM_ENV, writeSessionSettings } from "./shim";
import { discoverTranscripts, readTranscriptSummary, type DiscoveredTranscript } from "./transcripts";
import type {
  AskAnswer,
  ChangedFile,
  PermissionDecision,
  RemoteFrame,
  RemoteInfo,
  RemotePending,
  RemoteRunPointer,
  RemoteSession,
  RemoteStatus,
} from "./types";

/**
 * Claude Code sessions a person runs on the gate server, from their cockpit.
 *
 * A session on the desktop is a `claude` in a pty the cockpit owns. Here it is
 * the same thing owned by this process instead: a real interactive `claude`
 * in a pty on the server, in one of gate's connected repositories, driven
 * over `/api/v1/remote` — its bytes streamed to the cockpit, its keystrokes
 * posted back, its questions and approvals held by the hook hub until the
 * person answers them. Nothing about the session is emulated, and the run it
 * starts is an ordinary `/gate:run`: the same plugin (loaded from this
 * server's own `plugins/gate`, so it is always this server's version), a
 * worktree per run, reported on the person's own key.
 *
 * Each person gets their own Claude Code config dir and their own gate client
 * home under `<GATE_HOME>/remote/people/<person>`, so one person's
 * transcripts, pinned run definitions and session pointers are never
 * another's, and the child's model calls and CLI calls carry that person's
 * key, so they are metered and owned as theirs.
 *
 * The session outlives the connection that started it: closing the cockpit
 * leaves it running, a question it asks waits here, and the next stream
 * replays each terminal's recent output. Only the gate process ending ends
 * them — and then the transcript is still the session, and resuming it works.
 */

/** A session whose terminal printed nothing for this long while "working" is at its prompt. */
const QUIET_MS = 12_000;
/** How much of each terminal's recent output is kept for a cockpit that connects later. */
const SCREEN_BYTES = 256 * 1024;
/** Idle, unwatched and holding no run: put to sleep after this long. `GATE_REMOTE_IDLE_MIN=0` turns it off. */
const IDLE_MS = () => Math.max(0, Number(process.env.GATE_REMOTE_IDLE_MIN ?? 30)) * 60_000;
/** Live terminals one person may hold at once. */
const MAX_LIVE = () => Math.max(1, Number(process.env.GATE_REMOTE_MAX ?? 8));

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

interface Terminal {
  handle: string;
  token: string;
  owner: string;
  teamId: string;
  repo: string | null;
  cwd: string;
  proc: PtyProcess;
  sessionId: string | null;
  startedAt: number;
  lastOutputAt: number;
  lastInputAt: number;
  hasOutput: boolean;
  said: { status: RemoteStatus; at: number } | null;
  screen: string;
}

type Listener = { owner: string; teamId: string; send: (f: RemoteFrame) => void };

function gateHome(): string {
  return process.env.GATE_HOME || join(homedir(), ".gate");
}

/** Who a principal is, for everything here: their person, or the key itself when it names nobody. */
export function ownerOf(p: Principal): string {
  return (p.userId ?? `key-${p.keyId}`).replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Where this server's own model gateway and client API answer, for the child. */
function selfUrl(): string {
  if (process.env.GATE_SELF_URL) return process.env.GATE_SELF_URL.replace(/\/+$/, "");
  return `http://127.0.0.1:${process.env.PORT ?? 4141}`;
}

/**
 * The server's environment, minus what a session typing arbitrary commands
 * must not read: gate's own secrets, the server's model credentials, and the
 * framework's internals. The child is then given its person's key instead.
 */
const DROP_ENV = /^(GATE_|ANTHROPIC_|CLAUDE_|CLAUDECODE|NEXT_|__NEXT|NODE_OPTIONS$|npm_|TURBOPACK)/;

export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || DROP_ENV.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "1",
    LANG: env.LANG ?? "en_US.UTF-8",
    LC_CTYPE: env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "en_US.UTF-8",
    ...extra,
  };
}

const RUN_STATES = new Set(["agent", "wait", "delegate", "done", "failed", "stopped"]);

function readRunPointer(gateDir: string, sessionId: string): RemoteRunPointer | null {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(sessionId)) return null;
  try {
    const raw = JSON.parse(readFileSync(join(gateDir, "sessions", `${sessionId}.json`), "utf8")) as Record<string, unknown>;
    if (typeof raw.executionId !== "string" || typeof raw.state !== "string" || !RUN_STATES.has(raw.state)) return null;
    return {
      executionId: raw.executionId,
      state: raw.state as RemoteRunPointer["state"],
      nodeId: typeof raw.nodeId === "string" ? raw.nodeId : null,
      agent: typeof raw.agent === "string" ? raw.agent : null,
      asks: raw.asks === "question" || raw.asks === "approval" ? raw.asks : null,
      at: typeof raw.at === "number" ? raw.at : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Settles Claude Code's first-run questions for a person's config dir: the
 * onboarding and the "do you trust this folder" prompt for the repository
 * the session opens in. Both are real prompts in a real TUI, so a session
 * would still work without this — but the person would meet them in every
 * repository, on a machine they never chose to trust anything on.
 */
function preseedClaudeConfig(claudeDir: string, cwd: string): void {
  const file = join(claudeDir, ".claude.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  } catch {
    // first session for this person
  }
  const projects = (config.projects && typeof config.projects === "object" ? config.projects : {}) as Record<string, Record<string, unknown>>;
  // Claude Code keys trust by the real path: a checkout reached through a
  // symlink (macOS's /var is /private/var) is otherwise asked about anyway.
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // gone: the spawn will say so
  }
  const paths = [...new Set([cwd, real])];
  if (config.hasCompletedOnboarding === true && paths.every((p) => projects[p]?.hasTrustDialogAccepted === true)) return;
  const trusted = Object.fromEntries(
    paths.map((p) => [p, { ...(projects[p] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }]),
  );
  const next = { ...config, hasCompletedOnboarding: true, projects: { ...projects, ...trusted } };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export class RemoteManager {
  private terminals = new Map<string, Terminal>();
  private listeners = new Set<Listener>();
  private hub: HookHub;
  private hubStarted: Promise<void> | null = null;
  private claude: { path: string | null; reason: string | null } | null = null;
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private signatures = new Map<string, string>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private transcriptCache = new Map<string, { at: number; list: DiscoveredTranscript[] }>();

  constructor() {
    this.hub = new HookHub(
      (handle) => {
        const t = this.terminals.get(handle);
        if (!t) return null;
        return { token: t.token, repo: t.repo, readRun: (sid) => readRunPointer(this.gateDir(t.owner), sid) };
      },
      (e) => this.onHook(e),
      () => {
        for (const owner of new Set([...this.terminals.values()].map((t) => t.owner))) this.markDirty(owner, "pending");
      },
    );
  }

  // ------------------------------------------------------------- places

  home(): string {
    return join(gateHome(), "remote");
  }

  private personDir(owner: string): string {
    return join(this.home(), "people", owner);
  }

  claudeDir(owner: string): string {
    return join(this.personDir(owner), "claude");
  }

  gateDir(owner: string): string {
    return join(this.personDir(owner), "gate");
  }

  private pluginDir(): string {
    return resolve(process.env.GATE_PLUGIN_DIR || join(process.cwd(), "plugins", "gate"));
  }

  // ------------------------------------------------------- availability

  private claudeBinary(): { path: string | null; reason: string | null } {
    if (this.claude) return this.claude;
    const bin = process.env.GATE_CLAUDE_PATH || "claude";
    const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    this.claude =
      res.error || res.status !== 0
        ? { path: null, reason: `claude is not runnable on the gate server (${res.error?.message ?? `exit ${res.status}`}) — install Claude Code there, or set GATE_CLAUDE_PATH` }
        : { path: bin, reason: null };
    return this.claude;
  }

  availability(): { available: boolean; reason: string | null } {
    const pty = loadPty();
    if (!pty.spawn) return { available: false, reason: pty.reason };
    if (!existsSync(join(this.pluginDir(), ".claude-plugin", "plugin.json"))) {
      return { available: false, reason: `the gate plugin is not at ${this.pluginDir()} — set GATE_PLUGIN_DIR to this checkout's plugins/gate` };
    }
    const claude = this.claudeBinary();
    if (!claude.path) return { available: false, reason: claude.reason };
    return { available: true, reason: null };
  }

  info(principal: Principal): RemoteInfo {
    const allowed = principal.scopes.includes("remote");
    const { available, reason } = this.availability();
    return {
      allowed,
      available,
      reason: allowed ? reason : "this key does not have the remote scope",
      repos: allowed ? listRepos().map((r) => ({ id: r.id, name: r.name, source: r.source, status: r.status })) : [],
    };
  }

  // ----------------------------------------------------------- starting

  private async ensureHub(): Promise<void> {
    this.hubStarted ??= (async () => {
      mkdirSync(this.home(), { recursive: true, mode: 0o700 });
      await this.hub.start(hookSocketPath(this.home()));
    })().catch((e) => {
      this.hubStarted = null;
      throw e;
    });
    await this.hubStarted;
    if (!this.ticker) {
      // Statuses that move on a clock (a quiet "working" terminal is idle) and the idle sweep.
      this.ticker = setInterval(() => this.tick(), 5_000);
      this.ticker.unref?.();
    }
  }

  async start(principal: Principal, key: string, opts: { repo: string; prompt?: string; cols?: number; rows?: number }): Promise<RemoteSession> {
    const repo = getRepo(opts.repo);
    if (!repo) throw new RemoteError(`no repository "${opts.repo}" is connected to this gate`, 404, "REPO_NOT_FOUND");
    if (repo.status === "installing") throw new RemoteError(`"${repo.id}" is still installing on the gate; try again when it is ready`, 409, "REPO_NOT_READY");
    if (repo.status === "failed") throw new RemoteError(`"${repo.id}" failed its setup on the gate; fix it on the Repositories page first`, 409, "REPO_NOT_READY");
    if (!existsSync(repo.root)) throw new RemoteError(`"${repo.id}"'s checkout is gone from the gate (${repo.root})`, 409, "REPO_NOT_READY");
    const t = await this.spawn(principal, key, { cwd: repo.root, repo: repo.id, args: [], sessionId: null, cols: opts.cols, rows: opts.rows });
    if (opts.prompt?.trim()) this.typeWhenReady(t, opts.prompt.replace(/\s*\n\s*/g, " ").trim());
    return this.describe(t, Date.now());
  }

  async resume(principal: Principal, key: string, sessionId: string, opts: { cols?: number; rows?: number } = {}): Promise<RemoteSession> {
    const owner = ownerOf(principal);
    const live = [...this.terminals.values()].find((t) => t.owner === owner && t.sessionId === sessionId);
    if (live) return this.describe(live, Date.now());
    const found = this.transcripts(owner, true).find((s) => s.id === sessionId);
    if (!found) throw new RemoteError(`no session ${sessionId} of yours on this gate`, 404, "SESSION_NOT_FOUND");
    if (!found.cwd || !existsSync(found.cwd)) throw new RemoteError(`session ${sessionId} worked in ${found.cwd ?? "a directory"} that is gone`, 409, "SESSION_CWD_GONE");
    const t = await this.spawn(principal, key, {
      cwd: found.cwd,
      repo: this.repoFor(found.cwd),
      args: ["--resume", sessionId],
      sessionId,
      cols: opts.cols,
      rows: opts.rows,
    });
    return this.describe(t, Date.now());
  }

  private async spawn(
    principal: Principal,
    key: string,
    o: { cwd: string; repo: string | null; args: string[]; sessionId: string | null; cols?: number; rows?: number },
  ): Promise<Terminal> {
    const { available, reason } = this.availability();
    const pty = loadPty();
    const claude = this.claudeBinary();
    if (!available || !pty.spawn || !claude.path) throw new RemoteError(reason ?? "this gate cannot host sessions", 503, "REMOTE_UNAVAILABLE");
    const owner = ownerOf(principal);
    const live = [...this.terminals.values()].filter((t) => t.owner === owner).length;
    if (live >= MAX_LIVE()) {
      throw new RemoteError(`you already have ${live} sessions running on this gate; close one first`, 429, "TOO_MANY_SESSIONS");
    }
    await this.ensureHub();

    const claudeDir = this.claudeDir(owner);
    const gateDir = this.gateDir(owner);
    mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    mkdirSync(gateDir, { recursive: true, mode: 0o700 });
    preseedClaudeConfig(claudeDir, o.cwd);
    const hooksDir = join(this.home(), "hooks");
    const settings = writeSessionSettings(hooksDir, ensureShim(hooksDir));

    const handle = randomBytes(6).toString("hex");
    const token = randomBytes(16).toString("hex");
    const url = selfUrl();
    const env = childEnv(process.env, {
      CLAUDE_CONFIG_DIR: claudeDir,
      GATE_HOME: gateDir,
      // The CLI reads these before any file: the person's own key, this gate.
      GATE_URL: url,
      GATE_KEY: key,
      // Every model call through this gate, on the same key, so it is metered as theirs.
      ANTHROPIC_BASE_URL: `${url}/api/gateway`,
      ANTHROPIC_AUTH_TOKEN: key,
      [SHIM_ENV.sock]: this.hub.sockPath ?? "",
      [SHIM_ENV.terminal]: handle,
      [SHIM_ENV.token]: token,
    });
    const cols = Math.max(20, Math.min(500, Math.round(o.cols ?? 120)));
    const rows = Math.max(5, Math.min(200, Math.round(o.rows ?? 32)));

    let proc: PtyProcess;
    try {
      // A session here starts in auto mode, as it does in the cockpit. The
      // person who opened it is not sitting at this terminal — the prompts of
      // the default mode would reach them through the cockpit's Approvals one
      // by one, and a `/gate:run` started here would spend its nodes waiting on
      // them. `auto` decides without asking and hands over only what it will
      // not decide, which is still held for the person. Not
      // `bypassPermissions`: Claude Code refuses it when the process is root,
      // which is how a gate runs as a service.
      const args = ["--settings", settings, "--plugin-dir", this.pluginDir(), "--permission-mode", "auto", ...o.args];
      proc = pty.spawn(claude.path, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: o.cwd,
        env,
      });
    } catch (e) {
      throw new RemoteError(`could not start claude on the gate: ${(e as Error).message}`, 500, "SPAWN_FAILED");
    }

    const now = Date.now();
    const t: Terminal = {
      handle,
      token,
      owner,
      teamId: principal.teamId,
      repo: o.repo,
      cwd: o.cwd,
      proc,
      sessionId: o.sessionId,
      startedAt: now,
      lastOutputAt: now,
      lastInputAt: 0,
      hasOutput: false,
      said: null,
      screen: "",
    };
    this.terminals.set(handle, t);

    proc.onData((data) => {
      if (this.terminals.get(handle) !== t) return;
      t.hasOutput = true;
      t.lastOutputAt = Date.now();
      t.screen += data;
      if (t.screen.length > SCREEN_BYTES) t.screen = t.screen.slice(-SCREEN_BYTES);
      this.emit(t.owner, t.teamId, { type: "data", handle, data });
    });
    proc.onExit(({ exitCode }) => {
      if (this.terminals.get(handle) !== t) return;
      this.terminals.delete(handle);
      this.hub.dropTerminal(handle);
      this.emit(t.owner, t.teamId, { type: "exit", handle, code: exitCode });
      this.markDirty(t.owner, "sessions");
    });
    this.markDirty(owner, "sessions");
    return t;
  }

  /** Types a first prompt once the TUI has drawn itself and gone quiet, as the cockpit does on a desktop. */
  private typeWhenReady(t: Terminal, text: string): void {
    const started = Date.now();
    const tick = () => {
      if (this.terminals.get(t.handle) !== t) return;
      const quiet = t.hasOutput && Date.now() - t.lastOutputAt > 1200;
      if (quiet || Date.now() - started > 30_000) {
        t.proc.write(text);
        setTimeout(() => {
          if (this.terminals.get(t.handle) === t) t.proc.write("\r");
        }, 200).unref?.();
        return;
      }
      setTimeout(tick, 250).unref?.();
    };
    setTimeout(tick, 1500).unref?.();
  }

  // ----------------------------------------------------------- terminal

  /** The caller's own terminal; someone else's reads as not there at all. */
  private own(principal: Principal, handle: string): Terminal {
    const t = this.terminals.get(handle);
    if (!t || t.owner !== ownerOf(principal) || t.teamId !== principal.teamId) {
      throw new RemoteError(`no terminal ${handle} of yours on this gate`, 404, "TERMINAL_NOT_FOUND");
    }
    return t;
  }

  write(principal: Principal, handle: string, data: string): void {
    const t = this.own(principal, handle);
    t.lastInputAt = Date.now();
    t.proc.write(data);
  }

  resize(principal: Principal, handle: string, cols: number, rows: number): void {
    const t = this.own(principal, handle);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) return;
    try {
      t.proc.resize(cols, rows);
    } catch {
      // already gone
    }
  }

  /** A fresh frame without changing the size: one column narrower and back, which every TUI repaints for. */
  redraw(principal: Principal, handle: string): void {
    const t = this.own(principal, handle);
    try {
      const { cols, rows } = t.proc;
      t.proc.resize(Math.max(2, cols - 1), rows);
      t.proc.resize(cols, rows);
    } catch {
      // already gone
    }
  }

  close(principal: Principal, handle: string): void {
    this.kill(this.own(principal, handle));
  }

  private kill(t: Terminal): void {
    this.terminals.delete(t.handle);
    this.hub.dropTerminal(t.handle);
    try {
      t.proc.kill();
    } catch {
      // already gone
    }
    // A child trapping HUP must not outlive being closed.
    const pid = t.proc.pid;
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // exited
      }
    }, 3_000).unref?.();
    this.emit(t.owner, t.teamId, { type: "exit", handle: t.handle, code: 0 });
    this.markDirty(t.owner, "sessions");
  }

  // ----------------------------------------------------------- listing

  private transcripts(owner: string, fresh = false): DiscoveredTranscript[] {
    const cached = this.transcriptCache.get(owner);
    if (!fresh && cached && Date.now() - cached.at < 2_000) return cached.list;
    const list = discoverTranscripts(this.claudeDir(owner), 40);
    this.transcriptCache.set(owner, { at: Date.now(), list });
    return list;
  }

  private repoFor(cwd: string): string | null {
    const repo = listRepos().find((r) => cwd === r.root || cwd.startsWith(`${r.root.replace(/\/+$/, "")}/`));
    return repo?.id ?? null;
  }

  private statusOf(t: Terminal, now: number): RemoteStatus {
    const held = this.hub.pending().filter((p) => p.handle === t.handle);
    if (held.some((p) => p.kind === "permission")) return "blocked";
    if (held.length) return "waiting";
    const status = t.said?.status ?? "idle";
    if (status === "working" && t.hasOutput && now - t.lastOutputAt > QUIET_MS) return "idle";
    return status;
  }

  private describe(t: Terminal, now: number, transcript?: DiscoveredTranscript): RemoteSession {
    return {
      id: t.sessionId ?? `remote:${t.handle}`,
      handle: t.handle,
      repo: t.repo,
      cwd: t.cwd,
      title: transcript?.title ?? null,
      startedAt: t.startedAt,
      lastActiveAt: Math.max(t.lastOutputAt, t.said?.at ?? 0, transcript?.lastActiveAt ?? 0),
      presence: "live",
      status: this.statusOf(t, now),
      run: t.sessionId ? readRunPointer(this.gateDir(t.owner), t.sessionId) : null,
    };
  }

  private listFor(owner: string, teamId: string): RemoteSession[] {
    const now = Date.now();
    const transcripts = this.transcripts(owner);
    const byId = new Map(transcripts.map((s) => [s.id, s]));
    const live = [...this.terminals.values()].filter((t) => t.owner === owner && t.teamId === teamId);
    const liveIds = new Set(live.map((t) => t.sessionId).filter(Boolean));
    const out: RemoteSession[] = live
      .map((t) => this.describe(t, now, t.sessionId ? byId.get(t.sessionId) : undefined))
      .sort((a, b) => b.startedAt - a.startedAt);
    const gateDir = this.gateDir(owner);
    for (const s of transcripts) {
      if (liveIds.has(s.id)) continue;
      out.push({
        id: s.id,
        handle: null,
        repo: s.cwd ? this.repoFor(s.cwd) : null,
        cwd: s.cwd ?? "",
        title: s.title,
        startedAt: s.startedAt,
        lastActiveAt: s.lastActiveAt,
        presence: "asleep",
        status: "exited",
        run: readRunPointer(gateDir, s.id),
      });
    }
    return out;
  }

  sessions(principal: Principal): RemoteSession[] {
    return this.listFor(ownerOf(principal), principal.teamId);
  }

  private pendingFor(owner: string, teamId: string): RemotePending[] {
    return this.hub.pending().filter((p) => {
      const t = p.handle ? this.terminals.get(p.handle) : undefined;
      return !!t && t.owner === owner && t.teamId === teamId;
    });
  }

  pending(principal: Principal): RemotePending[] {
    return this.pendingFor(ownerOf(principal), principal.teamId);
  }

  private ownPending(principal: Principal, id: string): void {
    const handle = this.hub.terminalOf(id);
    const t = handle ? this.terminals.get(handle) : undefined;
    if (!t || t.owner !== ownerOf(principal) || t.teamId !== principal.teamId) {
      throw new RemoteError(`nothing of yours is waiting as ${id}`, 404, "ASK_NOT_FOUND");
    }
  }

  answer(principal: Principal, id: string, answer: AskAnswer): void {
    this.ownPending(principal, id);
    const r = this.hub.answer(id, answer);
    if (!r.ok) throw new RemoteError(r.error, r.status, "ASK_REFUSED");
  }

  decide(principal: Principal, id: string, decision: PermissionDecision): void {
    this.ownPending(principal, id);
    const r = this.hub.decide(id, decision);
    if (!r.ok) throw new RemoteError(r.error, r.status, "ASK_REFUSED");
  }

  // ------------------------------------------------------------- stream

  /**
   * Follows the caller's sessions. The listener first gets the hello — every
   * session and everything waiting — then each live terminal's recent output,
   * so a cockpit that connects to a session already going sees its screen.
   */
  subscribe(principal: Principal, send: (f: RemoteFrame) => void): () => void {
    const owner = ownerOf(principal);
    const listener: Listener = { owner, teamId: principal.teamId, send };
    send({ type: "hello", at: Date.now(), sessions: this.listFor(owner, principal.teamId), pending: this.pendingFor(owner, principal.teamId) });
    for (const t of this.terminals.values()) {
      if (t.owner === owner && t.teamId === principal.teamId && t.screen) send({ type: "screen", handle: t.handle, data: t.screen });
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(owner: string, teamId: string, frame: RemoteFrame): void {
    for (const l of this.listeners) {
      if (l.owner !== owner || l.teamId !== teamId) continue;
      try {
        l.send(frame);
      } catch {
        // one broken stream must not stop the others
      }
    }
  }

  /** Coalesces list frames: a burst of hooks becomes one `sessions` and one `pending`. */
  private markDirty(owner: string, what: "sessions" | "pending"): void {
    this.dirty.add(`${what}:${owner}`);
    if (what === "pending") this.dirty.add(`sessions:${owner}`);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const dirty = [...this.dirty];
      this.dirty.clear();
      for (const entry of dirty) {
        const [what, owner] = [entry.slice(0, entry.indexOf(":")), entry.slice(entry.indexOf(":") + 1)];
        for (const teamId of new Set([...this.listeners].filter((l) => l.owner === owner).map((l) => l.teamId))) {
          if (what === "pending") {
            this.emit(owner, teamId, { type: "pending", at: Date.now(), pending: this.pendingFor(owner, teamId) });
          } else {
            const sessions = this.listFor(owner, teamId);
            this.signatures.set(`${owner}:${teamId}`, signature(sessions));
            this.emit(owner, teamId, { type: "sessions", at: Date.now(), sessions });
          }
        }
      }
    }, 150);
    this.flushTimer.unref?.();
  }

  private onHook(e: HookEvent): void {
    const t = this.terminals.get(e.terminal);
    if (!t) return;
    if (t.sessionId !== e.sessionId) t.sessionId = e.sessionId;
    if (e.status) t.said = { status: e.status, at: e.at };
    this.markDirty(t.owner, "sessions");
  }

  /** Emits a list whose statuses moved on the clock alone, and puts idle terminals to sleep. */
  private tick(): void {
    const now = Date.now();
    const idle = IDLE_MS();
    for (const t of [...this.terminals.values()]) {
      if (!idle || this.statusOf(t, now) !== "idle") continue;
      if (now - Math.max(t.lastOutputAt, t.lastInputAt, t.said?.at ?? 0) < idle) continue;
      const run = t.sessionId ? readRunPointer(this.gateDir(t.owner), t.sessionId) : null;
      if (run && (run.state === "agent" || run.state === "wait" || run.state === "delegate")) {
        // A run in its hands is not idle, whatever the terminal looks like.
        if (getExecution(run.executionId)?.status === "running") continue;
      }
      this.kill(t);
    }
    for (const l of this.listeners) {
      const key = `${l.owner}:${l.teamId}`;
      const sessions = this.listFor(l.owner, l.teamId);
      const sig = signature(sessions);
      if (this.signatures.get(key) === sig) continue;
      this.signatures.set(key, sig);
      this.emit(l.owner, l.teamId, { type: "sessions", at: now, sessions });
    }
  }

  // ------------------------------------------------------------ changes

  /** The directory a run of the caller's worked in on this server: its worktree, else the session's own directory. */
  private runDir(principal: Principal, executionId: string): string {
    const owner = ownerOf(principal);
    const worktree = join(this.gateDir(owner), "workspaces", executionId);
    if (existsSync(worktree)) return worktree;
    for (const s of this.listFor(owner, principal.teamId)) {
      if (s.run?.executionId === executionId && s.cwd && existsSync(s.cwd)) return s.cwd;
    }
    throw new RemoteError("this run has no working directory on the gate", 404, "RUN_DIR_NOT_FOUND");
  }

  async changes(principal: Principal, executionId: string): Promise<ChangedFile[]> {
    return changedFilesIn(this.runDir(principal, executionId));
  }

  async fileDiff(principal: Principal, executionId: string, file: ChangedFile): Promise<string> {
    return fileDiffIn(this.runDir(principal, executionId), file);
  }

  /** For tests: every terminal gone, the socket closed. */
  async shutdown(): Promise<void> {
    for (const t of [...this.terminals.values()]) this.kill(t);
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    await this.hub.stop();
    this.hubStarted = null;
  }

  /** For tests: the title a transcript gives, without a cache in the way. */
  titleOf(path: string): string | null {
    return readTranscriptSummary(path).title;
  }
}

function signature(sessions: RemoteSession[]): string {
  return sessions.map((s) => `${s.id}|${s.handle}|${s.status}|${s.run?.state}|${s.run?.nodeId}|${s.run?.asks}|${s.title}`).join(";");
}

const g = globalThis as unknown as { __gateRemote?: RemoteManager };

/** One manager per process: route handlers are separate modules, the terminals are not. */
export function remoteManager(): RemoteManager {
  return (g.__gateRemote ??= new RemoteManager());
}

export async function resetRemoteForTests(): Promise<void> {
  await g.__gateRemote?.shutdown();
  g.__gateRemote = undefined;
}
