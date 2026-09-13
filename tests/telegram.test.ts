import { describe, expect, it } from "vitest";

import type { WorkflowEvent } from "@/events/types";
import { createExecution } from "@/executions/store";
import { getKey, type Principal } from "@/lib/apikeys";
import { createTeam, createUser } from "@/lib/teams";
import { RemoteError } from "@/remote/manager";
import type {
  AskAnswer,
  PermissionDecision,
  Question,
  RemoteFrame,
  RemoteInfo,
  RemotePending,
  RemotePendingAsk,
  RemotePendingPermission,
  RemoteSession,
} from "@/remote/types";
import type { Keyboard, SendOptions, TelegramApi, TgUpdate } from "@/telegram/api";
import { TelegramBot, type RemoteLike } from "@/telegram/bot";
import { askText, cb, newDraft, parseCallback } from "@/telegram/render";
import { createLinkCode, credentialsFor, getLink, LINK_CODE_MS } from "@/telegram/store";

/**
 * Telegram answers what a person's sessions on the gate are waiting for.
 *
 * The bot is a cockpit in a chat: it follows the person's remote sessions on
 * their own key, sends each question and permission prompt with buttons, and
 * settles it through the same calls the cockpit makes. These drive it with a
 * fake Bot API and a fake remote manager, so no `claude` is ever started.
 */

createTeam("Tau", "tau");
const ann = createUser({ email: "ann@tau.test", name: "Ann", teamId: "tau" });
const bob = createUser({ email: "bob@tau.test", name: "Bob", teamId: "tau" });

class FakeApi implements TelegramApi {
  private next = 1000;
  sent: Array<{ chatId: string; text: string; opts?: SendOptions; id: number }> = [];
  edits: Array<{ chatId: string; messageId: number; text: string; keyboard?: Keyboard }> = [];
  toasts: Array<string | undefined> = [];

  async getMe() {
    return { id: 1, username: "gate_test_bot" };
  }
  async getUpdates() {
    return [];
  }
  async sendMessage(chatId: string, text: string, opts?: SendOptions) {
    const id = this.next++;
    this.sent.push({ chatId, text, opts, id });
    return { message_id: id };
  }
  async editMessage(chatId: string, messageId: number, text: string, keyboard?: Keyboard) {
    this.edits.push({ chatId, messageId, text, keyboard });
  }
  async answerCallback(_id: string, text?: string) {
    this.toasts.push(text);
  }
  async setCommands() {}

  lastTo(chatId: number) {
    return this.sent.filter((s) => s.chatId === String(chatId)).at(-1)!;
  }
  lastEditOf(messageId: number) {
    return this.edits.filter((e) => e.messageId === messageId).at(-1)!;
  }
}

class FakeRemote {
  private pendingByOwner = new Map<string, RemotePending[]>();
  private listeners: Array<{ owner: string; send: (f: RemoteFrame) => void }> = [];
  answers: Array<{ owner: string; id: string; answer: AskAnswer }> = [];
  decisions: Array<{ owner: string; id: string; decision: PermissionDecision }> = [];
  starts: Array<{ owner: string; key: string; opts: { repo: string; prompt?: string } }> = [];

  private ownerOf(p: Principal): string {
    return p.userId ?? `key-${p.keyId}`;
  }

  info(p: Principal): RemoteInfo {
    return {
      allowed: p.scopes.includes("remote"),
      available: true,
      reason: null,
      repos: [
        { id: "app", name: "app", source: "/src/app", status: "ready" },
        { id: "web", name: "web", source: "/src/web", status: "ready" },
        { id: "broken", name: "broken", source: "/src/broken", status: "failed" },
      ],
    };
  }

  async start(p: Principal, key: string, opts: { repo: string; prompt?: string }): Promise<RemoteSession> {
    this.starts.push({ owner: this.ownerOf(p), key, opts });
    return {
      id: "remote:abcabcabcabc",
      handle: "abcabcabcabc",
      repo: opts.repo,
      cwd: "/src",
      title: null,
      startedAt: 0,
      lastActiveAt: 0,
      presence: "live",
      status: "idle",
      run: null,
    };
  }

  sessions(): RemoteSession[] {
    return [];
  }

  pending(p: Principal): RemotePending[] {
    return this.pendingByOwner.get(this.ownerOf(p)) ?? [];
  }

  subscribe(p: Principal, send: (f: RemoteFrame) => void): () => void {
    const listener = { owner: this.ownerOf(p), send };
    this.listeners.push(listener);
    send({ type: "hello", at: 0, sessions: [], pending: this.pending(p) });
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** What the hub holds for a person changes, as a hook or an answer would change it. */
  set(owner: string, pending: RemotePending[]): void {
    this.pendingByOwner.set(owner, pending);
    for (const l of this.listeners) if (l.owner === owner) l.send({ type: "pending", at: 0, pending });
  }

  private take(p: Principal, id: string): string {
    const owner = this.ownerOf(p);
    const list = this.pendingByOwner.get(owner) ?? [];
    if (!list.some((x) => x.id === id)) throw new RemoteError(`nothing of yours is waiting as ${id}`, 404, "ASK_NOT_FOUND");
    this.set(owner, list.filter((x) => x.id !== id));
    return owner;
  }

  answer(p: Principal, id: string, answer: AskAnswer): void {
    const owner = this.take(p, id);
    this.answers.push({ owner, id, answer });
  }

  decide(p: Principal, id: string, decision: PermissionDecision): void {
    const owner = this.take(p, id);
    this.decisions.push({ owner, id, decision });
  }

  close(): void {}
}

let updateId = 1;
const msg = (chatId: number, text: string, replyTo?: number): TgUpdate => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    chat: { id: chatId, type: "private" },
    from: { id: chatId, username: `u${chatId}` },
    text,
    ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
  },
});
const tap = (chatId: number, data: string, messageId: number): TgUpdate => ({
  update_id: updateId++,
  callback_query: { id: `cq${updateId}`, from: { id: chatId }, message: { message_id: messageId, chat: { id: chatId, type: "private" } }, data },
});

const base = { sessionId: "s1", handle: "h1", repo: "app", executionId: "exec-12345678", nodeId: "clarify", cwd: "/src/app", askedAt: 0 };
const ask = (id: string, questions: Question[], kind: "question" | "approval" = "question"): RemotePendingAsk => ({
  ...base,
  id,
  kind,
  questions,
  context: "I read the repository.",
});
const permission = (id: string, suggestions: unknown[] = []): RemotePendingPermission => ({
  ...base,
  id,
  kind: "permission",
  toolName: "Bash",
  toolInput: { command: "npm test" },
  summary: "npm test",
  suggestions,
});

const approve: Question = {
  question: "Ship the plan?",
  header: "Plan",
  multiSelect: false,
  options: [
    { label: "Approve", description: "go ahead" },
    { label: "Revise", description: "" },
  ],
};
const road: Question = {
  question: "Which road?",
  header: "Road",
  multiSelect: false,
  options: [
    { label: "quick", description: "" },
    { label: "full", description: "" },
  ],
};
const scope: Question = {
  question: "Which packages?",
  header: "Scope",
  multiSelect: true,
  options: [
    { label: "api", description: "" },
    { label: "web", description: "" },
  ],
};

function setup() {
  const api = new FakeApi();
  const remote = new FakeRemote();
  const bot = new TelegramBot({
    api,
    remote: () => remote as unknown as RemoteLike,
    workflows: () => [{ id: "dev-quick", name: "Quick" }],
    subscribeWorkflows: () => () => {},
  });
  return { api, remote, bot };
}

async function send(bot: TelegramBot, u: TgUpdate) {
  await bot.handleUpdate(u);
  await bot.idle();
}

async function link(bot: TelegramBot, chatId: number, userId: string | null) {
  const { code } = createLinkCode(userId);
  await send(bot, msg(chatId, `/start ${code}`));
}

describe("linking a chat", () => {
  it("links once per code, on a key of the person's that may run sessions", async () => {
    const { api, bot } = setup();
    const { code } = createLinkCode(ann.id);
    await send(bot, msg(101, `/start ${code}`));
    expect(getLink("101")?.userId).toBe(ann.id);
    const creds = credentialsFor("101");
    expect(creds?.principal.userId).toBe(ann.id);
    expect(creds?.principal.scopes).toContain("remote");
    expect(api.lastTo(101).text).toContain("Linked to <b>Ann</b>");

    await send(bot, msg(102, `/start ${code}`));
    expect(getLink("102")).toBeNull();
    expect(api.lastTo(102).text).toContain("expired or was already used");

    const stale = createLinkCode(ann.id, Date.now() - LINK_CODE_MS - 1);
    await send(bot, msg(102, `/start ${stale.code}`));
    expect(getLink("102")).toBeNull();
  });

  it("does nothing for a chat that is not linked, or is not a private chat", async () => {
    const { api, remote, bot } = setup();
    await send(bot, msg(199, "/sessions"));
    expect(api.lastTo(199).text).toContain("not linked");
    await send(bot, tap(199, cb.submit("a1"), 5));
    expect(api.toasts.at(-1)).toContain("not linked");
    expect(remote.answers).toHaveLength(0);

    await send(bot, { update_id: updateId++, message: { message_id: 1, chat: { id: -5, type: "group" }, text: "/help" } });
    expect(api.sent.filter((s) => s.chatId === "-5")).toHaveLength(0);
  });

  it("unlinking revokes the chat's key, and relinking replaces it", async () => {
    const { bot } = setup();
    await link(bot, 118, ann.id);
    const keyId = getLink("118")!.keyId;
    await send(bot, msg(118, "/unlink"));
    expect(getLink("118")).toBeNull();
    expect(getKey(keyId)?.revoked).toBe(true);
    expect(credentialsFor("118")).toBeNull();

    await link(bot, 119, ann.id);
    const first = getLink("119")!.keyId;
    await link(bot, 119, ann.id);
    expect(getKey(first)?.revoked).toBe(true);
    expect(getLink("119")!.keyId).not.toBe(first);
  });
});

describe("answering from Telegram", () => {
  it("sends what is waiting, and one tap answers a single question", async () => {
    const { api, remote, bot } = setup();
    await link(bot, 111, ann.id);
    remote.set(ann.id, [ask("a1", [approve], "approval")]);
    await bot.idle();

    const prompt = api.lastTo(111);
    expect(prompt.text).toContain("Approval needed");
    expect(prompt.text).toContain("Ship the plan?");
    expect(prompt.opts!.keyboard!.map((r) => r[0].text)).toEqual(["Approve", "Revise", "✏️ Other…"]);

    await send(bot, tap(111, prompt.opts!.keyboard![0][0].callback_data, prompt.id));
    expect(remote.answers).toEqual([{ owner: ann.id, id: "a1", answer: { answers: { "Ship the plan?": "Approve" } } }]);
    const edit = api.lastEditOf(prompt.id);
    expect(edit.text).toContain("Answered from Telegram: Approve");
    expect(edit.keyboard).toBeUndefined();
    // The hub letting go of what was answered here is not news.
    expect(api.edits.some((e) => e.text.includes("Settled elsewhere"))).toBe(false);
  });

  it("walks several questions, with several picks and a typed answer", async () => {
    const { api, remote, bot } = setup();
    await link(bot, 112, ann.id);
    remote.set(ann.id, [ask("b2", [road, scope])]);
    await bot.idle();
    const prompt = api.lastTo(112);

    await send(bot, tap(112, cb.pick("b2", 0, 1), prompt.id));
    expect(remote.answers).toHaveLength(0);
    await send(bot, tap(112, cb.pick("b2", 0, 0), prompt.id));
    expect(api.toasts.at(-1)).toBe("That question has moved on.");

    await send(bot, tap(112, cb.pick("b2", 1, 0), prompt.id));
    expect(api.lastEditOf(prompt.id).keyboard![0][0].text).toBe("☑️ api");

    await send(bot, tap(112, cb.other("b2", 1), prompt.id));
    const typeBox = api.lastTo(112);
    expect(typeBox.opts?.forceReply).toBe(true);
    await send(bot, msg(112, "docs", typeBox.id));

    await send(bot, tap(112, cb.next("b2", 1), prompt.id));
    expect(api.lastEditOf(prompt.id).keyboard![0].map((b) => b.text)).toEqual(["✅ Submit", "↺ Start over"]);
    await send(bot, tap(112, cb.submit("b2"), prompt.id));
    expect(remote.answers[0].answer).toEqual({ answers: { "Which road?": "full", "Which packages?": ["api", "docs"] } });
  });

  it("takes a reply to a question as a note", async () => {
    const { api, remote, bot } = setup();
    await link(bot, 113, ann.id);
    remote.set(ann.id, [ask("c3", [approve])]);
    await bot.idle();
    const prompt = api.lastTo(113);
    await send(bot, msg(113, "wait until Monday", prompt.id));
    expect(remote.answers[0].answer).toEqual({ answers: {}, response: "wait until Monday" });
    expect(api.lastEditOf(prompt.id).text).toContain("Replied from Telegram");
  });

  it("allows, always allows, or denies a permission with the reason replied", async () => {
    const { api, remote, bot } = setup();
    await link(bot, 114, ann.id);
    remote.set(ann.id, [permission("d4", [{ type: "addRules" }])]);
    await bot.idle();
    const prompt = api.lastTo(114);
    expect(prompt.text).toContain("npm test");
    expect(prompt.opts!.keyboard![0].map((b) => b.text)).toEqual(["✅ Allow", "✅ Always", "⛔ Deny"]);
    await send(bot, tap(114, cb.perm("d4", "always"), prompt.id));
    expect(remote.decisions[0]).toMatchObject({ id: "d4", decision: { behavior: "allow", always: true } });

    remote.set(ann.id, [permission("e5")]);
    await bot.idle();
    const second = api.lastTo(114);
    expect(second.opts!.keyboard![0].map((b) => b.text)).toEqual(["✅ Allow", "⛔ Deny"]);
    await send(bot, msg(114, "not on main", second.id));
    expect(remote.decisions[1]).toMatchObject({ id: "e5", decision: { behavior: "deny", message: "not on main" } });
  });

  it("marks a prompt answered somewhere else, and refuses a late tap", async () => {
    const { api, remote, bot } = setup();
    await link(bot, 115, ann.id);
    remote.set(ann.id, [ask("f6", [approve])]);
    await bot.idle();
    const prompt = api.lastTo(115);
    remote.set(ann.id, []);
    await bot.idle();
    expect(api.lastEditOf(prompt.id).text).toContain("Settled elsewhere");
    await send(bot, tap(115, cb.pick("f6", 0, 0), prompt.id));
    expect(api.toasts.at(-1)).toBe("This is no longer waiting.");
    expect(remote.answers).toHaveLength(0);
  });
});

describe("starting a run from Telegram", () => {
  it("asks for the repository, the workflow, then the task", async () => {
    const { api, remote, bot } = setup();
    await link(bot, 116, ann.id);
    await send(bot, msg(116, "/run"));
    const repos = api.lastTo(116);
    expect(repos.opts!.keyboard!.map((r) => r[0].text)).toEqual(["app", "web"]);

    await send(bot, tap(116, repos.opts!.keyboard![1][0].callback_data, repos.id));
    const workflows = api.lastTo(116);
    expect(workflows.opts!.keyboard!.map((r) => r[0].text)).toEqual(["Quick (dev-quick)", "🧭 Let gate pick"]);

    await send(bot, tap(116, cb.workflow(null), workflows.id));
    expect(api.lastTo(116).opts?.forceReply).toBe(true);
    await send(bot, msg(116, "fix the\nlogin bug"));

    expect(remote.starts).toHaveLength(1);
    expect(remote.starts[0].opts).toEqual({ repo: "web", prompt: "/gate:run fix the login bug" });
    expect(remote.starts[0].owner).toBe(ann.id);
    expect(remote.starts[0].key).toMatch(/^gate_/);
    expect(api.lastTo(116).text).toContain("Started a session");
  });

  it("starts one from a single line", async () => {
    const { remote, bot } = setup();
    await link(bot, 120, ann.id);
    await send(bot, msg(120, "/run app dev-quick bump the version"));
    expect(remote.starts[0].opts).toEqual({ repo: "app", prompt: "/gate:run dev-quick bump the version" });
  });
});

describe("run notifications", () => {
  it("tells a person when their own runs end, once", async () => {
    const { api, bot } = setup();
    await link(bot, 117, bob.id);
    const now = Date.now();
    createExecution("tg-run-bob", "dev", { task: "bob's task" }, now, null, { origin: "local", driver: "session", userId: bob.id, teamId: "tau" });
    createExecution("tg-run-ann", "dev", { task: "ann's task" }, now, null, { origin: "local", driver: "session", userId: ann.id, teamId: "tau" });
    const before = api.sent.length;

    bot.onWorkflowEvent({ type: "workflow.completed", executionId: "tg-run-ann", at: now, status: "completed", terminalNodeId: "done" });
    bot.onWorkflowEvent({ type: "workflow.completed", executionId: "tg-run-bob", at: now, status: "completed", terminalNodeId: "done" });
    bot.onWorkflowEvent({ type: "workflow.failed", executionId: "tg-run-bob", at: now, message: "boom" } as WorkflowEvent);
    await bot.idle();

    const after = api.sent.slice(before);
    const toBob = after.filter((s) => s.chatId === "117");
    expect(toBob).toHaveLength(1);
    expect(toBob[0].text).toContain("Run finished");
    expect(toBob[0].text).toContain("bob's task");
    expect(after.filter((s) => s.text.includes("ann's task")).every((s) => s.chatId !== "117")).toBe(true);
  });
});

describe("render", () => {
  it("round-trips every button inside Telegram's 64 bytes", () => {
    const all = [
      cb.pick("ab12cd34ef56ab12", 0, 3),
      cb.other("ab12cd34ef56ab12", 1),
      cb.next("ab12cd34ef56ab12", 2),
      cb.submit("ab12cd34ef56ab12"),
      cb.restart("ab12cd34ef56ab12"),
      cb.perm("ab12cd34ef56ab12", "always"),
      cb.repo(4),
      cb.workflow(null),
      cb.workflow(7),
      cb.close("abcdef123456"),
    ];
    for (const data of all) {
      expect(parseCallback(data)).not.toBeNull();
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
    expect(parseCallback(cb.workflow(null))).toEqual({ kind: "workflow", i: null });
    expect(parseCallback(cb.perm("ab", "deny"))).toEqual({ kind: "perm", id: "ab", decision: "deny" });
    expect(parseCallback("q:zz:1:1")).toBeNull();
  });

  it("escapes what a session wrote and stays inside a message", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `option ${i}`, description: "d".repeat(200) }));
    const p = ask("ab", [{ ...approve, question: "<b>x</b> & y", options: many }]);
    p.context = "z".repeat(10_000);
    const text = askText(p, newDraft(p.questions));
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });
});
