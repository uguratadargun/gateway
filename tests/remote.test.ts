import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { GET as remoteInfo } from "@/app/api/v1/remote/route";
import { GET as listAsks } from "@/app/api/v1/remote/asks/route";
import { POST as settleAsk } from "@/app/api/v1/remote/asks/[id]/route";
import { GET as listSessions, POST as startSession } from "@/app/api/v1/remote/sessions/route";
import { GET as streamRemote } from "@/app/api/v1/remote/stream/route";
import { POST as inputTerminal } from "@/app/api/v1/remote/terminals/[handle]/input/route";
import { DELETE as closeTerminal } from "@/app/api/v1/remote/terminals/[handle]/route";
import { createKey } from "@/lib/apikeys";
import { createTeam, createUser } from "@/lib/teams";
import { resetRemoteForTests } from "@/remote/manager";
import { setPtyForTests, type PtyProcess, type PtySpawnOptions } from "@/remote/pty";
import { createRepo, setRepoStatus } from "@/repos/store";

/**
 * Sessions on the gate server, driven from a cockpit.
 *
 * The pty is a fake — what is under test is everything around it: who may
 * start one, what the child is started with (its person's key, its own config
 * dir, none of gate's secrets), that a person only ever reaches their own
 * terminals and questions, and that a question a session asks through its
 * hook is held until its person answers it over the API.
 */

createTeam("Remote", "remote-team");
const ann = createUser({ email: "ann@remote.test", name: "Ann", teamId: "remote-team" });
const bob = createUser({ email: "bob@remote.test", name: "Bob", teamId: "remote-team" });
const annKey = createKey({ name: "ann", userId: ann.id, teamId: "remote-team", scopes: ["gateway", "workflows", "remote"] }).plaintext;
const annPlainKey = createKey({ name: "ann plain", userId: ann.id, teamId: "remote-team" }).plaintext;
const bobKey = createKey({ name: "bob", userId: bob.id, teamId: "remote-team", scopes: ["gateway", "workflows", "remote"] }).plaintext;

const repoRoot = mkdtempSync(join(tmpdir(), "gate-remote-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repoRoot });
createRepo({ id: "shop", name: "shop", source: "git@example.com:acme/shop.git", root: repoRoot, cloned: false, baseRef: null, setup: [], prepare: [] });
setRepoStatus("shop", "ready");

// `claude --version` has to succeed for the server to offer sessions; node answers it.
process.env.GATE_CLAUDE_PATH = process.execPath;
process.env.GATE_SECRET = "must-not-reach-the-child";

interface FakeTerminal {
  file: string;
  args: string[];
  opts: PtySpawnOptions;
  written: string[];
  emit: (data: string) => void;
  exit: (code: number) => void;
}
const spawned: FakeTerminal[] = [];

setPtyForTests((file, args, opts) => {
  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(e: { exitCode: number }) => void> = [];
  const fake: FakeTerminal = {
    file,
    args,
    opts,
    written: [],
    emit: (d) => dataCbs.forEach((cb) => cb(d)),
    exit: (code) => exitCbs.forEach((cb) => cb({ exitCode: code })),
  };
  spawned.push(fake);
  const proc: PtyProcess = {
    pid: 999_999,
    cols: opts.cols,
    rows: opts.rows,
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    write: (d) => fake.written.push(d),
    resize: () => {},
    kill: () => {},
  };
  return proc;
});

afterAll(async () => {
  await resetRemoteForTests();
  setPtyForTests(null);
});

const as = (key: string, path: string, init: RequestInit = {}) =>
  new Request(`http://gate.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const params = <T extends string>(name: T, value: string) => ({ params: Promise.resolve({ [name]: value } as Record<T, string>) });

/** Sends one hook frame the way the shim does and resolves with the reply line. */
function hook(sock: string, frame: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(sock, () => c.write(`${JSON.stringify(frame)}\n`));
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => (buf += d));
    c.on("close", () => resolve(buf.trim()));
    c.on("error", reject);
  });
}

async function started(key: string, body: Record<string, unknown>) {
  const res = await startSession(as(key, "/api/v1/remote/sessions", json(body)));
  expect(res.status).toBe(201);
  const { session } = (await res.json()) as { session: { handle: string; id: string } };
  return { session, terminal: spawned[spawned.length - 1] };
}

describe("remote sessions", () => {
  it("tells a key without the scope that it may not, and one with it what it can open", async () => {
    const plain = await (await remoteInfo(as(annPlainKey, "/api/v1/remote"))).json();
    expect(plain).toMatchObject({ allowed: false, repos: [] });
    const allowed = await (await remoteInfo(as(annKey, "/api/v1/remote"))).json();
    expect(allowed).toMatchObject({ allowed: true, available: true, reason: null });
    expect(allowed.repos).toEqual([{ id: "shop", name: "shop", source: "git@example.com:acme/shop.git", status: "ready" }]);

    const refused = await startSession(as(annPlainKey, "/api/v1/remote/sessions", json({ repo: "shop" })));
    expect(refused.status).toBe(403);
  });

  it("starts claude in the repository on the person's own key, config dir and none of gate's secrets", async () => {
    const { session, terminal } = await started(annKey, { repo: "shop", cols: 100, rows: 30 });
    expect(session.handle).toMatch(/^[0-9a-f]{12}$/);
    expect(terminal.file).toBe(process.execPath);
    expect(terminal.args).toContain("--settings");
    expect(terminal.args[terminal.args.indexOf("--plugin-dir") + 1]).toMatch(/plugins[\\/]gate$/);
    expect(terminal.opts.cwd).toBe(repoRoot);
    expect(terminal.opts.cols).toBe(100);
    const env = terminal.opts.env;
    expect(env.GATE_KEY).toBe(annKey);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(annKey);
    expect(env.ANTHROPIC_BASE_URL).toMatch(/\/api\/gateway$/);
    expect(env.CLAUDE_CONFIG_DIR).toContain(join("remote", "people", ann.id, "claude"));
    expect(env.GATE_HOME).toContain(join("remote", "people", ann.id, "gate"));
    expect(env.GATE_SECRET).toBeUndefined();
    expect(env.GATE_CLAUDE_PATH).toBeUndefined();

    const bad = await startSession(as(annKey, "/api/v1/remote/sessions", json({ repo: "nope" })));
    expect(bad.status).toBe(404);
  });

  it("reaches only its person's terminals", async () => {
    const { session, terminal } = await started(annKey, { repo: "shop" });
    const handle = session.handle;
    const theirs = await inputTerminal(as(bobKey, `/api/v1/remote/terminals/${handle}/input`, json({ data: "rm -rf /\r" })), params("handle", handle));
    expect(theirs.status).toBe(404);
    const mine = await inputTerminal(as(annKey, `/api/v1/remote/terminals/${handle}/input`, json({ data: "hello" })), params("handle", handle));
    expect(mine.status).toBe(200);
    expect(terminal.written).toEqual(["hello"]);

    const bobs = (await (await listSessions(as(bobKey, "/api/v1/remote/sessions"))).json()) as { sessions: unknown[] };
    expect(bobs.sessions).toEqual([]);
  });

  it("holds a session's question until its person answers it, and answers the hook with it", async () => {
    const { session, terminal } = await started(annKey, { repo: "shop" });
    const env = terminal.opts.env;
    const sock = env.GATE_REMOTE_SOCK;
    expect(sock).toBeTruthy();

    // A frame carrying another terminal's token is not believed.
    const forged = await hook(sock, {
      v: 1,
      terminal: env.GATE_REMOTE_TERMINAL,
      token: "not-the-token",
      payload: { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "s-forged", tool_input: { questions: [] } },
    });
    expect(forged).toBe("");

    const questions = [{ question: "Which package?", header: "Scope", multiSelect: false, options: [{ label: "web", description: "" }] }];
    const reply = hook(sock, {
      v: 1,
      terminal: env.GATE_REMOTE_TERMINAL,
      token: env.GATE_REMOTE_TOKEN,
      payload: { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "s-ann", cwd: repoRoot, tool_input: { questions } },
    });

    let pending: Array<{ id: string; kind: string; handle: string; sessionId: string }> = [];
    for (let i = 0; i < 50 && !pending.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = ((await (await listAsks(as(annKey, "/api/v1/remote/asks"))).json()) as { pending: typeof pending }).pending;
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "question", handle: session.handle, sessionId: "s-ann" });
    expect(((await (await listAsks(as(bobKey, "/api/v1/remote/asks"))).json()) as { pending: unknown[] }).pending).toEqual([]);

    const id = pending[0].id;
    expect((await settleAsk(as(bobKey, `/api/v1/remote/asks/${id}`, json({ answer: { answers: {} } })), params("id", id))).status).toBe(404);
    const ok = await settleAsk(as(annKey, `/api/v1/remote/asks/${id}`, json({ answer: { answers: { "Which package?": "web" } } })), params("id", id));
    expect(ok.status).toBe(200);

    const answered = JSON.parse(await reply);
    expect(answered.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers: { "Which package?": "web" } },
    });

    // The hook named the session: the live list now calls it by its id.
    await new Promise((r) => setTimeout(r, 200));
    const sessions = ((await (await listSessions(as(annKey, "/api/v1/remote/sessions"))).json()) as { sessions: Array<{ id: string; handle: string }> }).sessions;
    expect(sessions.find((s) => s.handle === session.handle)?.id).toBe("s-ann");
  });

  it("streams a hello, each live terminal's screen, then its output and its end", async () => {
    const { session, terminal } = await started(annKey, { repo: "shop" });
    terminal.emit("before the cockpit looked");

    const abort = new AbortController();
    const res = await streamRemote(as(annKey, "/api/v1/remote/stream", { signal: abort.signal }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const frames: Array<Record<string, unknown>> = [];
    let buffer = "";
    const until = async (pred: () => boolean) => {
      while (!pred()) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value);
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (chunk.startsWith("data: ")) frames.push(JSON.parse(chunk.slice(6)));
        }
      }
    };

    await until(() => frames.some((f) => f.type === "screen" && f.handle === session.handle));
    expect(frames[0].type).toBe("hello");
    expect((frames[0].sessions as Array<{ handle: string }>).some((s) => s.handle === session.handle)).toBe(true);
    expect(frames.find((f) => f.type === "screen" && f.handle === session.handle)).toMatchObject({ data: "before the cockpit looked" });

    terminal.emit("after");
    await until(() => frames.some((f) => f.type === "data" && f.data === "after"));

    const closed = await closeTerminal(as(annKey, `/api/v1/remote/terminals/${session.handle}`, { method: "DELETE" }), params("handle", session.handle));
    expect(closed.status).toBe(200);
    await until(() => frames.some((f) => f.type === "exit" && f.handle === session.handle));
    abort.abort();

    const after = ((await (await listSessions(as(annKey, "/api/v1/remote/sessions"))).json()) as { sessions: Array<{ handle: string | null }> }).sessions;
    expect(after.some((s) => s.handle === session.handle)).toBe(false);
  });
});
