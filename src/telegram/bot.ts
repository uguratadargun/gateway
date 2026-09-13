import { subscribeAllWorkflows } from "@/events/bus";
import type { WorkflowEvent } from "@/events/types";
import { getExecution } from "@/executions/store";
import type { ExecutionRecord } from "@/executions/types";
import type { Principal } from "@/lib/apikeys";
import { getUser } from "@/lib/teams";
import { scopeForPrincipal } from "@/lib/tenancy";
import { RemoteError, type RemoteManager } from "@/remote/manager";
import type { AskAnswer, PermissionDecision, RemotePending } from "@/remote/types";
import { listWorkflows } from "@/workflows/registry";

import { TelegramError, type TelegramApi, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./api";
import {
  answersFor,
  askKeyboard,
  askText,
  cb,
  clip,
  esc,
  newDraft,
  parseCallback,
  permissionKeyboard,
  permissionText,
  runEventText,
  sessionsKeyboard,
  sessionsText,
  settledFooter,
  type AskDraft,
  type Callback,
} from "./render";
import { credentialsFor, listLinks, redeemLinkCode, unlink } from "./store";

/**
 * The gate bot: a person's remote sessions, answered and started from Telegram.
 *
 * It holds nothing a person has to settle — the hook hub in src/remote does.
 * For every linked chat it follows that person's sessions the way a cockpit
 * does (RemoteManager.subscribe, on the chat's own key), sends each question
 * and permission prompt as a message with buttons, and settles it through the
 * same answer/decide calls the cockpit's panels make. Whichever side answers
 * first wins; the other sees the prompt go, and here the message says so.
 *
 * A run started from a chat is an ordinary remote session: a `claude` on this
 * server in one of its repositories, typed `/gate:run …` as its first prompt.
 *
 * Everything that happens for one chat — a frame from the hub, a button, a
 * message — is done in order on that chat's own chain, so a button pressed
 * while its question is still being sent meets the question, not a race.
 */

export type RemoteLike = Pick<RemoteManager, "info" | "start" | "sessions" | "pending" | "subscribe" | "answer" | "decide" | "close">;

export interface WorkflowChoice {
  id: string;
  name: string;
}

export interface BotDeps {
  api: TelegramApi;
  remote: () => RemoteLike;
  /** The workflows a person may run; their team's definitions by default. */
  workflows?: (principal: Principal) => WorkflowChoice[];
  execution?: (id: string) => ExecutionRecord | null;
  subscribeWorkflows?: (listener: (e: WorkflowEvent) => void) => () => void;
}

interface SentPrompt {
  pending: RemotePending;
  /** Null for a permission prompt, which has no questions. */
  draft: AskDraft | null;
  messageId: number | null;
  /** Answered from here: its going away is expected, not news. */
  settled: boolean;
}

interface RunDraft {
  repos: string[];
  repo: string | null;
  workflows: WorkflowChoice[];
  /** undefined: not chosen yet; null: the run picks its own. */
  workflow: string | null | undefined;
  task: string | null;
}

type Awaiting = { kind: "other"; id: string; q: number; promptId: number } | { kind: "task" } | null;

interface ChatState {
  unsub: (() => void) | null;
  sent: Map<string, SentPrompt>;
  awaiting: Awaiting;
  run: RunDraft | null;
  chain: Promise<void>;
}

type Creds = NonNullable<ReturnType<typeof credentialsFor>>;

export const BOT_COMMANDS = [
  { command: "run", description: "Start a gate run on the server" },
  { command: "sessions", description: "Your live sessions on the server" },
  { command: "pending", description: "Send again what is waiting on you" },
  { command: "cancel", description: "Forget the run or answer being typed" },
  { command: "unlink", description: "Disconnect this chat from gate" },
  { command: "help", description: "What this bot does" },
];

const HELP = [
  "<b>gate</b> sends you what your sessions on the gate server ask: questions, plan approvals and permission prompts. Tap to answer; reply to a message to send a note instead.",
  "",
  "/run — start a run: pick a repository and a workflow, then say what it should do. Or in one line: <code>/run &lt;repo&gt; &lt;workflow&gt; &lt;task…&gt;</code>",
  "/sessions — your live sessions, and a button to close each",
  "/pending — send again everything that is waiting on you",
  "/cancel — forget a run or an answer you were typing",
  "/unlink — disconnect this chat",
].join("\n");

const NOT_LINKED =
  "This chat is not linked to a gate. Ask for a Telegram link on the gate's Team page and open it, or send <code>/start &lt;code&gt;</code>.";

const GONE = "This is no longer waiting.";

function errorText(e: unknown): string {
  if (e instanceof RemoteError && e.status === 404 && e.code === "ASK_NOT_FOUND") return GONE;
  return clip(e instanceof Error ? e.message : String(e), 180);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export class TelegramBot {
  private chats = new Map<string, ChatState>();
  private finished = new Set<string>();
  private abort = new AbortController();
  private loop: Promise<void> | null = null;
  private stopped = false;
  private unsubWorkflows: (() => void) | null = null;
  username: string | null = null;
  lastError: string | null = null;

  constructor(private readonly deps: BotDeps) {}

  private get api(): TelegramApi {
    return this.deps.api;
  }

  private remote(): RemoteLike {
    return this.deps.remote();
  }

  // --------------------------------------------------------- lifecycle

  get running(): boolean {
    return this.loop !== null && !this.stopped;
  }

  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.unsubWorkflows = (this.deps.subscribeWorkflows ?? subscribeAllWorkflows)((e) => this.onWorkflowEvent(e));
    this.loop = this.poll();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.unsubWorkflows?.();
    this.unsubWorkflows = null;
    for (const s of this.chats.values()) s.unsub?.();
    this.chats.clear();
  }

  private async poll(): Promise<void> {
    let offset = 0;
    let backoff = 1_000;
    while (!this.stopped) {
      try {
        if (!this.username) {
          const me = await this.api.getMe();
          this.username = me.username ?? null;
          await this.api.setCommands(BOT_COMMANDS).catch(() => {});
          for (const link of listLinks()) this.attach(link.chatId);
        }
        const updates = await this.api.getUpdates(offset, 25, this.abort.signal);
        this.lastError = null;
        backoff = 1_000;
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          await this.handleUpdate(u).catch((e) => console.error("[gate] telegram update failed:", e));
        }
      } catch (e) {
        if (this.stopped) break;
        this.lastError = e instanceof Error ? e.message : String(e);
        const wait = e instanceof TelegramError && e.retryAfter ? e.retryAfter * 1_000 : backoff;
        backoff = Math.min(backoff * 2, 60_000);
        await sleep(wait, this.abort.signal);
      }
    }
  }

  /** For tests: resolves once every chat has done everything queued on it. */
  async idle(): Promise<void> {
    for (;;) {
      const chains = [...this.chats.values()].map((s) => s.chain);
      await Promise.all(chains);
      if ([...this.chats.values()].every((s, i) => s.chain === chains[i]) && chains.length === this.chats.size) return;
    }
  }

  // ------------------------------------------------------------- chats

  private state(chatId: string): ChatState {
    let s = this.chats.get(chatId);
    if (!s) {
      s = { unsub: null, sent: new Map(), awaiting: null, run: null, chain: Promise.resolve() };
      this.chats.set(chatId, s);
    }
    return s;
  }

  private run(chatId: string, fn: () => Promise<unknown>): Promise<void> {
    const s = this.state(chatId);
    const next = s.chain
      .then(fn)
      .then(() => undefined)
      .catch((e) => console.error(`[gate] telegram chat ${chatId}:`, e));
    s.chain = next;
    return next;
  }

  private async say(chatId: string, text: string): Promise<void> {
    await this.api.sendMessage(chatId, text);
  }

  /** Follows the chat's person's sessions; what is waiting arrives at once. */
  attach(chatId: string): void {
    const s = this.state(chatId);
    if (s.unsub) return;
    const creds = credentialsFor(chatId);
    if (!creds) return;
    try {
      s.unsub = this.remote().subscribe(creds.principal, (frame) => {
        if (frame.type !== "hello" && frame.type !== "pending") return;
        const pending = frame.pending;
        void this.run(chatId, () => this.syncPending(chatId, pending));
      });
    } catch (e) {
      console.error(`[gate] telegram could not follow chat ${chatId}:`, e);
    }
  }

  detach(chatId: string): void {
    const s = this.chats.get(chatId);
    s?.unsub?.();
    this.chats.delete(chatId);
  }

  // ----------------------------------------------------------- updates

  async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.message) return this.onMessage(u.message);
  }

  private onMessage(m: TgMessage): Promise<void> {
    // Only a person's own chat with the bot: in a group, anyone present could press the buttons.
    if (m.chat.type !== "private" || !m.text) return Promise.resolve();
    const chatId = String(m.chat.id);
    const text = m.text.trim();
    return this.run(chatId, async () => {
      const cmd = text.match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
      if (cmd?.[1] === "start") return this.linkChat(chatId, m, cmd[2]?.trim() ?? "");
      const creds = credentialsFor(chatId);
      if (!creds) return this.say(chatId, NOT_LINKED);
      const s = this.state(chatId);
      if (!s.unsub) this.attach(chatId);

      if (cmd) {
        s.awaiting = null;
        switch (cmd[1]) {
          case "run":
            return this.beginRun(chatId, creds, cmd[2]?.trim() ?? "");
          case "sessions": {
            const live = this.remote()
              .sessions(creds.principal)
              .filter((x) => x.presence === "live");
            return this.api.sendMessage(chatId, sessionsText(live), { keyboard: sessionsKeyboard(live) });
          }
          case "pending": {
            const pending = this.remote().pending(creds.principal);
            s.sent.clear();
            if (!pending.length) return this.say(chatId, "Nothing is waiting on you.");
            return this.syncPending(chatId, pending);
          }
          case "cancel":
            s.run = null;
            return this.say(chatId, "Cancelled.");
          case "unlink":
            unlink(chatId);
            this.detach(chatId);
            return this.say(chatId, "Unlinked. The key this chat held is revoked; nothing more will arrive here.");
          default:
            return this.say(chatId, HELP);
        }
      }

      const replyTo = m.reply_to_message?.message_id;
      const repliedTo = replyTo == null ? undefined : [...s.sent.values()].find((p) => p.messageId === replyTo);
      if (repliedTo) return this.replyToPrompt(chatId, creds, repliedTo, text);
      if (s.awaiting?.kind === "other") return this.typedOther(chatId, creds, text);
      if (s.awaiting?.kind === "task" && s.run) {
        s.awaiting = null;
        s.run.task = text;
        return this.advanceRun(chatId, creds);
      }
      return this.say(chatId, "Nothing is waiting for a message. /run starts a run; /help says the rest.");
    });
  }

  private async linkChat(chatId: string, m: TgMessage, code: string): Promise<void> {
    if (!code) {
      return this.say(chatId, credentialsFor(chatId) ? `This chat is already linked.\n\n${HELP}` : NOT_LINKED);
    }
    const link = redeemLinkCode(code, { chatId, username: m.from?.username ?? null });
    if (!link) return this.say(chatId, "That link has expired or was already used. Ask for a new one on the gate's Team page.");
    this.detach(chatId);
    const user = link.userId ? getUser(link.userId) : null;
    const who = user ? (user.name ?? user.email) : `the ${link.teamId} team`;
    await this.say(chatId, `Linked to <b>${esc(who)}</b>.\n\n${HELP}`);
    this.attach(chatId);
  }

  private onCallback(q: TgCallbackQuery): Promise<void> {
    const chat = q.message?.chat;
    if (!chat || chat.type !== "private" || !q.message) return this.api.answerCallback(q.id);
    const chatId = String(chat.id);
    const messageId = q.message.message_id;
    return this.run(chatId, async () => {
      const creds = credentialsFor(chatId);
      if (!creds) return this.api.answerCallback(q.id, "This chat is not linked to gate.");
      const c = parseCallback(q.data);
      let toast: string | undefined;
      try {
        toast = c ? await this.act(chatId, creds, c, messageId) : undefined;
      } catch (e) {
        toast = errorText(e);
      }
      await this.api.answerCallback(q.id, toast);
    });
  }

  private async act(chatId: string, creds: Creds, c: Callback, messageId: number): Promise<string | undefined> {
    const s = this.state(chatId);
    switch (c.kind) {
      case "pick":
      case "other":
      case "next":
      case "submit":
      case "restart":
        return this.askAction(chatId, creds, c);
      case "perm": {
        const sent = s.sent.get(c.id);
        if (!sent || sent.settled || sent.pending.kind !== "permission") return GONE;
        const decision: PermissionDecision =
          c.decision === "deny" ? { behavior: "deny", message: "Denied from Telegram." } : { behavior: "allow", always: c.decision === "always" };
        this.remote().decide(creds.principal, c.id, decision);
        sent.settled = true;
        const outcome = c.decision === "deny" ? "⛔ Denied from Telegram" : c.decision === "always" ? "✅ Always allowed from Telegram" : "✅ Allowed from Telegram";
        await this.redraw(chatId, sent, settledFooter(outcome));
        return "Sent";
      }
      case "repo": {
        const repo = s.run?.repos[c.i];
        if (!s.run || !repo) return "Start again with /run.";
        s.run.repo = repo;
        await this.api.editMessage(chatId, messageId, `Repository: <b>${esc(repo)}</b>`);
        await this.advanceRun(chatId, creds);
        return undefined;
      }
      case "workflow": {
        if (!s.run || s.run.workflow !== undefined) return "Start again with /run.";
        const chosen = c.i === null ? null : s.run.workflows[c.i];
        if (chosen === undefined) return "Start again with /run.";
        s.run.workflow = chosen?.id ?? null;
        await this.api.editMessage(chatId, messageId, `Workflow: <b>${esc(chosen ? chosen.name : "gate picks")}</b>`);
        await this.advanceRun(chatId, creds);
        return undefined;
      }
      case "close":
        this.remote().close(creds.principal, c.handle);
        await this.api.editMessage(chatId, messageId, "Session closed.");
        return "Closed";
    }
  }

  // ----------------------------------------------------------- prompts

  private textOf(sent: SentPrompt, footer?: string): string {
    return sent.pending.kind === "permission" ? permissionText(sent.pending, footer) : askText(sent.pending, sent.draft!, footer);
  }

  private async redraw(chatId: string, sent: SentPrompt, settled?: string): Promise<void> {
    if (sent.messageId == null) return;
    const keyboard = settled ? undefined : sent.pending.kind === "permission" ? permissionKeyboard(sent.pending) : askKeyboard(sent.pending, sent.draft!);
    await this.api.editMessage(chatId, sent.messageId, this.textOf(sent, settled), keyboard);
  }

  /** Brings the chat's messages in line with what is waiting: new prompts sent, gone ones marked. */
  private async syncPending(chatId: string, pending: RemotePending[]): Promise<void> {
    const s = this.state(chatId);
    const ids = new Set(pending.map((p) => p.id));
    for (const [id, sent] of s.sent) {
      if (ids.has(id)) continue;
      s.sent.delete(id);
      if (s.awaiting?.kind === "other" && s.awaiting.id === id) s.awaiting = null;
      if (!sent.settled) await this.redraw(chatId, sent, settledFooter("Settled elsewhere — answered in the cockpit, or the session ended."));
    }
    for (const p of pending) {
      if (s.sent.has(p.id)) continue;
      const sent: SentPrompt = { pending: p, draft: p.kind === "permission" ? null : newDraft(p.questions), messageId: null, settled: false };
      s.sent.set(p.id, sent);
      const keyboard = p.kind === "permission" ? permissionKeyboard(p) : askKeyboard(p, sent.draft!);
      const msg = await this.api.sendMessage(chatId, this.textOf(sent), { keyboard });
      sent.messageId = msg.message_id;
    }
  }

  private async askAction(chatId: string, creds: Creds, c: Extract<Callback, { id: string }>): Promise<string | undefined> {
    const s = this.state(chatId);
    const sent = s.sent.get(c.id);
    if (!sent || sent.settled || sent.pending.kind === "permission" || !sent.draft) return GONE;
    const p = sent.pending;
    const draft = sent.draft;
    const moved = "That question has moved on.";
    switch (c.kind) {
      case "pick": {
        const q = p.questions[c.q];
        const o = q?.options[c.o];
        if (!q || !o || c.q !== draft.cursor) return moved;
        const pick = draft.picks[c.q];
        if (q.multiSelect) {
          pick.labels = pick.labels.includes(o.label) ? pick.labels.filter((l) => l !== o.label) : [...pick.labels, o.label];
        } else {
          pick.labels = [o.label];
          pick.other = null;
          draft.cursor = c.q + 1;
          if (p.questions.length === 1) return this.submitAsk(chatId, creds, sent, { answers: answersFor(p.questions, draft) });
        }
        break;
      }
      case "other": {
        const q = p.questions[c.q];
        if (!q || c.q !== draft.cursor) return moved;
        const prompt = await this.api.sendMessage(chatId, `✏️ Type your answer to <b>${esc(clip(q.header || q.question, 200))}</b>`, {
          forceReply: true,
        });
        s.awaiting = { kind: "other", id: p.id, q: c.q, promptId: prompt.message_id };
        return undefined;
      }
      case "next":
        if (c.q !== draft.cursor) return moved;
        draft.cursor = c.q + 1;
        break;
      case "restart":
        sent.draft = newDraft(p.questions);
        break;
      case "submit": {
        const answers = answersFor(p.questions, draft);
        if (!Object.keys(answers).length) return "Pick an answer first, or reply to the message with a note.";
        return this.submitAsk(chatId, creds, sent, { answers });
      }
    }
    await this.redraw(chatId, sent);
    return undefined;
  }

  private async submitAsk(chatId: string, creds: Creds, sent: SentPrompt, answer: AskAnswer): Promise<string> {
    this.remote().answer(creds.principal, sent.pending.id, answer);
    sent.settled = true;
    const picked = Object.values(answer.answers)
      .map((v) => (Array.isArray(v) ? v.join(", ") : v))
      .join(" · ");
    const outcome = answer.response
      ? `💬 Replied from Telegram: ${clip(answer.response, 200)}`
      : `✅ Answered from Telegram: ${clip(picked, 200)}`;
    await this.redraw(chatId, sent, settledFooter(outcome));
    return "Sent";
  }

  /** A reply to a prompt's message: a note for a question, a reason to deny a permission. */
  private async replyToPrompt(chatId: string, creds: Creds, sent: SentPrompt, text: string): Promise<void> {
    if (sent.settled) return this.say(chatId, GONE);
    try {
      if (sent.pending.kind === "permission") {
        this.remote().decide(creds.principal, sent.pending.id, { behavior: "deny", message: text });
        sent.settled = true;
        await this.redraw(chatId, sent, settledFooter(`⛔ Denied from Telegram: ${clip(text, 200)}`));
        return;
      }
      await this.submitAsk(chatId, creds, sent, { answers: answersFor(sent.pending.questions, sent.draft!), response: text });
    } catch (e) {
      await this.say(chatId, esc(errorText(e)));
    }
  }

  private async typedOther(chatId: string, creds: Creds, text: string): Promise<void> {
    const s = this.state(chatId);
    const awaiting = s.awaiting;
    if (awaiting?.kind !== "other") return;
    s.awaiting = null;
    const sent = s.sent.get(awaiting.id);
    if (!sent || sent.settled || sent.pending.kind === "permission" || !sent.draft) return this.say(chatId, GONE);
    const q = sent.pending.questions[awaiting.q];
    const pick = sent.draft.picks[awaiting.q];
    if (!q || !pick) return this.say(chatId, GONE);
    pick.other = text;
    if (!q.multiSelect) {
      pick.labels = [];
      sent.draft.cursor = awaiting.q + 1;
      if (sent.pending.questions.length === 1) {
        try {
          await this.submitAsk(chatId, creds, sent, { answers: answersFor(sent.pending.questions, sent.draft) });
        } catch (e) {
          await this.say(chatId, esc(errorText(e)));
        }
        return;
      }
    }
    await this.redraw(chatId, sent);
  }

  // -------------------------------------------------------------- runs

  private workflowsFor(principal: Principal): WorkflowChoice[] {
    if (this.deps.workflows) return this.deps.workflows(principal);
    return listWorkflows(scopeForPrincipal(principal)).workflows.map((w) => ({ id: w.id, name: w.name }));
  }

  /**
   * `/run`, with whatever the person already said: a repository id first, a
   * workflow id next, and the rest is the task. What is missing is asked for.
   */
  private async beginRun(chatId: string, creds: Creds, args: string): Promise<void> {
    const info = this.remote().info(creds.principal);
    if (!info.allowed || !info.available) {
      return this.say(chatId, `Sessions cannot start on this gate: ${esc(info.reason ?? "not available")}`);
    }
    const repos = info.repos.filter((r) => r.status === "ready").map((r) => r.id);
    if (!repos.length) return this.say(chatId, "No repository on this gate is ready. Connect one on the gate's Repositories page.");
    const draft: RunDraft = { repos, repo: null, workflows: this.workflowsFor(creds.principal), workflow: undefined, task: null };
    const words = args.split(/\s+/).filter(Boolean);
    if (words[0] && repos.includes(words[0])) draft.repo = words.shift()!;
    else if (repos.length === 1) draft.repo = repos[0];
    if (words[0] && draft.workflows.some((w) => w.id === words[0])) draft.workflow = words.shift()!;
    if (words.length) {
      draft.task = words.join(" ");
      // A task given without a workflow is left to the run to route, as `/gate:run <task>` is.
      if (draft.workflow === undefined) draft.workflow = null;
    }
    this.state(chatId).run = draft;
    await this.advanceRun(chatId, creds);
  }

  private async advanceRun(chatId: string, creds: Creds): Promise<void> {
    const s = this.state(chatId);
    const d = s.run;
    if (!d) return;
    if (!d.repo) {
      await this.api.sendMessage(chatId, "Which repository?", {
        keyboard: d.repos.slice(0, 40).map((id, i) => [{ text: clip(id, 60), callback_data: cb.repo(i) }]),
      });
      return;
    }
    if (d.workflow === undefined) {
      const rows = d.workflows.slice(0, 40).map((w, i) => [{ text: clip(w.name === w.id ? w.id : `${w.name} (${w.id})`, 60), callback_data: cb.workflow(i) }]);
      rows.push([{ text: "🧭 Let gate pick", callback_data: cb.workflow(null) }]);
      await this.api.sendMessage(chatId, `Which workflow on <b>${esc(d.repo)}</b>?`, { keyboard: rows });
      return;
    }
    if (!d.task) {
      s.awaiting = { kind: "task" };
      await this.api.sendMessage(chatId, "What should the run do?", { forceReply: true });
      return;
    }
    s.run = null;
    const task = d.task.replace(/\s+/g, " ").trim();
    try {
      await this.remote().start(creds.principal, creds.key, { repo: d.repo, prompt: `/gate:run ${d.workflow ? `${d.workflow} ` : ""}${task}` });
    } catch (e) {
      await this.say(chatId, `Could not start it: ${esc(errorText(e))}`);
      return;
    }
    await this.say(
      chatId,
      `🚀 Started a session on <b>${esc(d.repo)}</b>${d.workflow ? ` for <b>${esc(d.workflow)}</b>` : ""}.\n<i>${esc(clip(task, 300))}</i>\n\nIts questions and approvals will come here; /sessions shows how it is doing.`,
    );
  }

  // ------------------------------------------------------ notifications

  /** A person's run starting and ending, sent to every chat linked to them. */
  onWorkflowEvent(e: WorkflowEvent): void {
    if (e.type !== "workflow.started" && e.type !== "workflow.completed" && e.type !== "workflow.failed") return;
    if (e.type !== "workflow.started") {
      // An engine can say both "completed (failed)" and "failed" for one run; one message is enough.
      if (this.finished.has(e.executionId)) return;
      this.finished.add(e.executionId);
      if (this.finished.size > 1_000) this.finished.delete(this.finished.values().next().value!);
    }
    let links: ReturnType<typeof listLinks>;
    let run: ExecutionRecord | null;
    try {
      links = listLinks();
      if (!links.length) return;
      run = (this.deps.execution ?? getExecution)(e.executionId);
    } catch {
      return;
    }
    if (!run) return;
    const text = runEventText(e, run);
    for (const link of links) {
      const mine = link.userId ? run.userId === link.userId : !run.userId && run.teamId === link.teamId;
      if (mine) void this.run(link.chatId, () => this.say(link.chatId, text));
    }
  }
}
