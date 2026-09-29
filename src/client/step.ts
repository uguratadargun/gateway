import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { getAgent } from "@/agents/registry";
import type { ExecutionStepRecord } from "@/executions/types";
import type { PublicationTarget } from "@/repos/publish";
import { scopeAt, type DefinitionScope } from "@/lib/def-root";
import { parseOutput, prepareAgentNode } from "@/runtime/executors/agent";
import { runCommand } from "@/runtime/executors/command";
import { WorkflowError } from "@/runtime/errors";
import type { StepRecord, WorkflowState } from "@/runtime/state";
import { renderTemplate } from "@/agents/template";
import { conditionContext } from "@/runtime/state";
import {
  borrowDependencies,
  createRunWorkspace,
  readRemoteUrl,
  readRunDiff,
  // Only for undoing a `gate continue` that was refused — a worktree put back
  // the way it was found is not a publication.
  releaseRunWorkspace,
  restoreRunWorkspace,
  summarizeWorkspace,
  type RunWorkspace,
} from "@/runtime/workspace";
import { unattendedNotice } from "@/skills/inject";
import { getSkill, resolveSkillDir } from "@/skills/registry";
import { getWorkflow } from "@/workflows/registry";
import { definitionsHash } from "@/workflows/snapshot";
import { findNode, type WorkflowDefinition } from "@/workflows/types";
import type { AgentDefinition } from "@/agents/types";

import type { GateClient } from "./api";
import { CLI_VERSION } from "./api";
import { subagentName } from "./subagents";
import { cacheDir, cacheScope } from "./cache";
import { gateHome } from "./config";
import { shippingWarnings } from "./preflight";
import { releaseAndPublish } from "./release";
import { resolveRepo } from "./repo";
import { nextInSession, type SessionPosition } from "./walk";

/**
 * The environment variable the plugin's SessionStart hook sets, carrying the
 * Claude Code session's id. Read here so a run can say which session drives
 * it.
 */
export const SESSION_ID_ENV = "GATE_CLAUDE_SESSION";

/**
 * A run the developer's own Claude Code session drives, one node at a time.
 *
 * The engine runs a workflow inside one process and calls a model for each
 * agent node. That is right on a server and wrong on a laptop: it means a
 * second, headless Claude session doing work nobody can see, that cannot ask
 * the person sitting there a question — the one thing a session is for.
 *
 * So the loop is inverted. The session asks what to do (`gate next`), does it
 * with its own tools, in front of the user, and hands back the answer
 * (`gate step`). gate stays what it always was: the thing that decides where
 * the run goes next, from the graph and the outputs, never from the model.
 *
 * Command nodes are not handed over — they are argv from the workflow file, so
 * this runs them itself and moves on. Agent nodes split by executor.
 * `executor: gate` means the loop driving the run, which here is the session:
 * it gets the node, in front of the user, and can ask them. `executor:
 * claude-code` means the agent's own model, which the session's model cannot
 * stand in for: that node is a subagent of the session, started with the
 * Agent tool from the file gate keeps under ~/.claude/agents, and drawn live
 * in the terminal like the session's own work. Every model call is the
 * person's own Claude login; gate holds none.
 */

/** A skill an agent declares, as this machine has it. */
type SkillRef = { id: string; description: string; path: string | null };

/** What the session is told to do next, as JSON on stdout. */
export type Instruction =
  | {
      do: "agent";
      executionId: string;
      nodeId: string;
      agent: string;
      /** The agent's prompt, inputs already resolved. */
      prompt: string;
      /** Where to write the answer before handing it back; any file works, this one is ready. */
      outputFile: string;
      output: { type: "json" | "text"; schema?: Record<string, string> };
      /** Where the work happens. Never the user's own checkout. */
      workspace: string | null;
      /**
       * Set when this node is the person's turn: `question` wants their
       * answer in their words, `approval` a yes or a change. The run is
       * paused while it is out. Null for a node the session works on itself.
       */
      asks: "question" | "approval" | null;
      /** What the agent file says it needs; a session has its own tools. */
      tools: string[];
      /**
       * The skills this agent declares, unpacked on this machine.
       *
       * An agent that names a skill is an agent that follows it — that is what
       * declaring one means, as opposed to a model deciding to reach for one.
       * The headless executors hand them over their own way (a throwaway
       * plugin for a spawned Claude Code, the prose folded into the system
       * prompt for gate's own loop); a session gets the directory, because it
       * already knows what a skill is and can read the files the skill points
       * at.
       */
      skills: SkillRef[];
      timeoutMs: number | null;
      /**
       * The contract, restated with this node.
       *
       * The slash command explains all of this once, at the start. A run is
       * ten nodes and possibly two hours, by which point that explanation is
       * far behind and the hand-off is a blob of JSON — so the few rules that
       * decay worst come back with every node, including the exact command
       * that ends this one.
       */
      remember: string[];
    }
  | {
      /**
       * A node in its own model, run as a subagent of the session so that it
       * is drawn live in the terminal, on the person's own Claude login.
       */
      do: "delegate";
      executionId: string;
      nodeId: string;
      agent: string;
      model: string;
      /** The subagent to start, by name: a file gate keeps under ~/.claude/agents. */
      subagent: string;
      /**
       * The subagent that did this node's last pass in this run, when there
       * was one: continue it, context and all, instead of starting a fresh
       * one that reads everything again. Null on a node's first pass.
       */
      resume: string | null;
      /** The whole task for the subagent, inputs resolved; passed as it is. */
      prompt: string;
      /**
       * Where the answer goes. The prompt tells the subagent to write its
       * final JSON here itself, so the session hands the file back as it is
       * rather than retyping ten kilobytes through its own context.
       */
      outputFile: string;
      output: { type: "json" | "text"; schema?: Record<string, string> };
      workspace: string | null;
      skills: SkillRef[];
      timeoutMs: number | null;
      remember: string[];
    }
  | {
      do: "done";
      executionId: string;
      status: "completed" | "failed";
      branch: string | null;
      /** The worktree, when it is still there — a run that ended has it removed and its branch kept. */
      workspace: string | null;
      /** The command that shows what the run did, from wherever the work now is. */
      review: string | null;
    }
  | { do: "failed"; executionId: string; nodeId: string; error: { code: string; message: string } }
  /**
   * The run was ended from outside — Stop on the dashboard, or written off
   * after its machine went quiet — while this session was between two calls.
   * Nothing is left to do for it.
   */
  | { do: "stopped"; executionId: string; error: { code: string; message: string } };

/** Which node was handed out, so `gate step` can refuse an answer to another one. */
interface Pending {
  executionId: string;
  nodeId: string;
  stepIndex: number;
  visit: number;
  startedAt: number;
  /**
   * Set when the report that announced the node — and paused the run, for a
   * person's turn — did not reach the gate. The next `gate next` that hands
   * the same node out says it again rather than treating it as said.
   */
  unannounced?: true;
}

function pendingPath(executionId: string): string {
  return join(gateHome(), "runs", `${executionId}.json`);
}

function readPending(executionId: string): Pending | null {
  try {
    return JSON.parse(readFileSync(pendingPath(executionId), "utf8")) as Pending;
  } catch {
    return null;
  }
}

function writePending(pending: Pending): void {
  const file = pendingPath(pending.executionId);
  mkdirSync(join(gateHome(), "runs"), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
}

function clearPending(executionId: string): void {
  rmSync(pendingPath(executionId), { force: true });
}

/** Runs this process is already working on, so a command that calls another holds one lock. */
const heldRuns = new Set<string>();

/**
 * One `gate` command at a time per run, on this machine.
 *
 * `gate next` is not a look: it runs every command node between here and the
 * next agent node — a commit, a push, `gh pr create`. Two of them at once (a
 * `gate step` left in the background and a `gate next` to see where the run
 * is, or two sessions on one run) both found the same unrecorded command node
 * and both ran it; the gate kept the first step and dropped the second, but
 * the push had happened twice. So the command takes a lock file under the
 * run's name for as long as it works, and a second one is refused and told
 * why. A lock whose process is gone is taken over: a command killed mid-run
 * must not leave the run unreachable.
 */
export async function withRunLock<T>(executionId: string, work: () => Promise<T>): Promise<T> {
  if (heldRuns.has(executionId)) return work();
  const file = join(gateHome(), "runs", `${executionId}.lock`);
  mkdirSync(join(gateHome(), "runs"), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw e;
      const holder = Number.parseInt(readFileSync(file, "utf8"), 10);
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && processAlive(holder)) {
        throw new WorkflowError(
          "WORKFLOW_ROUTING_ERROR",
          `another gate command (pid ${holder}) is working on run ${executionId} right now — wait for it to finish, ` +
            `then run \`gate next ${executionId}\` to see where the run is`,
        );
      }
      rmSync(file, { force: true });
    }
  }
  heldRuns.add(executionId);
  try {
    return await work();
  } finally {
    heldRuns.delete(executionId);
    rmSync(file, { force: true });
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it is only somebody else's.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * What a Claude Code session was last told to do, on this machine.
 *
 * A person driving several runs from several terminals has nothing that says
 * which one is waiting on them. The session's id is known here (the plugin's
 * hook puts it in the environment), so every instruction handed out is also
 * written to `~/.gate/sessions/<session>.json`: which run, which node, and
 * whether it is the person's turn — a question or an approval. A desktop
 * cockpit, or a Claude Code hook, reads that file to say "this one wants
 * you" without a network call, and to sort a question from an approval
 * without guessing from its words. Nothing here reads it back.
 */
export interface SessionState {
  session: string;
  executionId: string;
  /** What the session was last told to do; done, failed and stopped are over. */
  state: "agent" | "wait" | "delegate" | "done" | "failed" | "stopped";
  nodeId: string | null;
  agent: string | null;
  /** Set while a node is the person's turn: what kind of turn. */
  asks: "question" | "approval" | null;
  at: number;
}

/** The session this process runs in, as the plugin's hook or Claude Code itself named it. */
export function currentSession(): string | undefined {
  return (process.env[SESSION_ID_ENV] ?? process.env.CLAUDE_CODE_SESSION_ID ?? "").trim() || undefined;
}

export function sessionStatePath(session: string): string {
  return join(gateHome(), "sessions", `${session}.json`);
}

/** Records an instruction against the session it was handed to. Silent without a session. */
export function noteSession(instruction: Instruction, at = Date.now()): SessionState | null {
  const session = currentSession();
  if (!session || !/^[A-Za-z0-9._-]{1,80}$/.test(session)) return null;
  const state: SessionState = {
    session,
    executionId: instruction.executionId,
    state: instruction.do,
    nodeId: "nodeId" in instruction ? instruction.nodeId : null,
    agent: "agent" in instruction ? instruction.agent : null,
    asks: instruction.do === "agent" ? instruction.asks : null,
    at,
  };
  try {
    mkdirSync(join(gateHome(), "sessions"), { recursive: true, mode: 0o700 });
    writeFileSync(sessionStatePath(session), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch {
    // A file that cannot be written is a session nobody can watch; the run is unaffected.
  }
  return state;
}

/** Everything on this machine that belongs to one run and is not its worktree. */
export function runDir(executionId: string): string {
  return join(gateHome(), "runs", executionId);
}

function runDefinitionsDir(executionId: string): string {
  return join(runDir(executionId), "definitions");
}

/**
 * Freezes the definitions a run starts with.
 *
 * Every `gate` command re-syncs the team's mirror first, which is right for
 * the next run and wrong for this one: a workflow edited on the dashboard
 * — or a gate update that refreshed the shipped pipeline — changed the graph
 * a run was halfway through, and its replay lined the recorded steps up
 * against nodes that had moved (measured here: a run that fell back to a
 * second plan approval the new graph no longer had). So the mirror is copied
 * once, at `begin`, and every later command reads the run's own copy. The
 * mirror keeps moving underneath, for runs not yet started.
 */
export function pinDefinitions(team: string, executionId: string): string {
  const dir = runDefinitionsDir(executionId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  cpSync(cacheDir(team), dir, { recursive: true });
  return dir;
}

/** The scope a run reads its definitions from: its pinned copy, or the mirror for a run that predates pinning. */
export function runScope(team: string, executionId: string): DefinitionScope {
  const dir = runDefinitionsDir(executionId);
  return existsSync(join(dir, "workflows")) ? scopeAt(dir, team) : cacheScope(team);
}

/** What a run kept on this machine besides its worktree: the pin, the marker, the logs. */
export function forgetRun(executionId: string): void {
  rmSync(runDir(executionId), { recursive: true, force: true });
  clearPending(executionId);
  const runs = join(gateHome(), "runs");
  if (!existsSync(runs)) return;
  for (const entry of readdirSync(runs)) {
    if (entry.startsWith(`${executionId}-`) && entry.endsWith(".log")) rmSync(join(runs, entry), { force: true });
  }
}

/**
 * Where a node's answer is written before `gate step` hands it back. One
 * file per pass, under the run's own directory, so nothing lands in /tmp
 * and a pass never overwrites the last one.
 */
export function outputFileFor(executionId: string, nodeId: string, visit: number): string {
  const dir = join(runDir(executionId), "out");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${nodeId}-${visit}.json`);
}

function subagentsPath(executionId: string): string {
  return join(runDir(executionId), "subagents.json");
}

/**
 * Which subagent did each node's last pass, by node id. Kept on disk rather
 * than in the session's memory: a run is an hour and a compaction away from
 * forgetting, and the file is what `gate next` reads to say "continue it".
 */
export function recallSubagent(executionId: string, nodeId: string): string | null {
  try {
    const all = JSON.parse(readFileSync(subagentsPath(executionId), "utf8")) as Record<string, string>;
    return all[nodeId] ?? null;
  } catch {
    return null;
  }
}

export function rememberSubagent(executionId: string, nodeId: string, subagentId: string): void {
  let all: Record<string, string> = {};
  try {
    all = JSON.parse(readFileSync(subagentsPath(executionId), "utf8")) as Record<string, string>;
  } catch {
    // First one.
  }
  all[nodeId] = subagentId;
  mkdirSync(runDir(executionId), { recursive: true, mode: 0o700 });
  writeFileSync(subagentsPath(executionId), `${JSON.stringify(all)}\n`, { mode: 0o600 });
}

/** The run's workspace, as it was recorded when the run began. */
function workspaceOf(execution: { workspace: RunWorkspace | null }): RunWorkspace | null {
  return execution.workspace ?? null;
}

/** How to see what a run did: in its worktree while there is one, else its branch against where it began. */
export function reviewCommand(ws: RunWorkspace): string {
  if (existsSync(ws.root)) return `git -C ${ws.root} diff${ws.baseCommit ? ` ${ws.baseCommit}` : ""}`;
  return `git -C ${ws.repo} diff ${ws.baseCommit ?? ws.baseRef}...${ws.branch}`;
}

export interface SessionRunContext {
  client: GateClient;
  team: string;
  /** Printed for the person watching; the session's own output is the rest. */
  say: (message: string) => void;
}

/** Starts a run and returns its first instruction. */
export async function begin(
  ctx: SessionRunContext,
  workflowId: string,
  input: Record<string, unknown>,
  cwd: string,
  repos: Record<string, string>,
  opts: { taskId?: string } = {},
): Promise<Instruction> {
  const scope = cacheScope(ctx.team);
  const workflow = getWorkflow(workflowId, scope);

  const runInput = { ...input };
  let repo: string | null = null;
  if (workflow.workspace) {
    repo = resolveRepo(workflow, runInput, cwd, repos);
    runInput.repo = repo;
  }

  // The plugin's session hook, or the id Claude Code itself puts in a tool's
  // environment: either names the session driving the run.
  const session = (process.env[SESSION_ID_ENV] ?? process.env.CLAUDE_CODE_SESSION_ID ?? "").trim() || undefined;
  // The publication target the gate answers with is ignored here: this run
  // ends in a later process, and `gate next` asks again then — so a repo
  // whose publishing changed mid-run is not held to what was true at start.
  const { executionId } = await ctx.client.startRun({
    workflowId: workflow.id,
    input: runInput,
    // Raw, for the server to normalise.
    client: {
      host: hostname(),
      repo: repo ?? undefined,
      remoteUrl: (repo && readRemoteUrl(repo)) || undefined,
      version: CLI_VERSION,
      session,
    },
    driver: "session",
    // Which piece of cross-team work this run serves: the work outlives the
    // session that walked it, so the run is filed under it from the start.
    taskId: opts.taskId,
    // From the mirror, which is what `pinDefinitions` freezes a line below:
    // the hash the server agrees to is the one for the copy this run walks.
    definitionsHash: definitionsHash(workflow.id, scope),
  });

  // The definitions this run will follow, frozen before anything reads them.
  pinDefinitions(ctx.team, executionId);

  if (workflow.workspace) {
    try {
      const workspace = createRunWorkspace({ ...workflow.workspace, repo: repo! }, executionId);
      ctx.say(`worktree ${workspace.root} on branch ${workspace.branch}`);
      const linked = borrowDependencies(workspace);
      if (linked.length) ctx.say(`  linked ${linked.join(", ")} from ${workspace.repo}`);
      for (const warning of shippingWarnings(workflow, readRemoteUrl(workspace.repo))) ctx.say(warning);
      // Recorded now, not at the end: the dashboard should show the branch
      // while the run is going, and every later `gate next` reads the
      // worktree back from here rather than recomputing it.
      await ctx.client.report(executionId, { events: [], steps: [], workspace });
    } catch (e) {
      const error = { code: e instanceof WorkflowError ? e.code : "WORKSPACE_ERROR", message: (e as Error).message };
      await ctx.client.finish(executionId, { status: "failed", error, stepCount: 0 }).catch(() => {});
      throw e;
    }
  }

  return next(ctx, executionId);
}

/**
 * Works out what runs next and, for everything that is not an agent, does it.
 *
 * The loop inside is what keeps command and control nodes off the session's
 * plate: it advances until it reaches an agent node, a terminal, or a failure.
 */
export async function next(
  ctx: SessionRunContext,
  executionId: string,
  opts: { full?: boolean } = {},
): Promise<Instruction> {
  return withRunLock(executionId, () => walkOn(ctx, executionId, opts));
}

async function walkOn(ctx: SessionRunContext, executionId: string, opts: { full?: boolean }): Promise<Instruction> {
  for (;;) {
    const { execution, steps, publish } = await ctx.client.execution(executionId);
    // Settled from outside since this session last looked: Stop on the
    // dashboard lands on the row directly for a run a session drives, and a
    // session that was gone for hours is written off there too. Either way
    // the walk is over, whatever the marker on disk still says.
    const stopped = stoppedOutside(execution);
    if (stopped) {
      clearPending(executionId);
      ctx.say(`■ run ${stopped.code === "RUN_CANCELLED" ? "stopped" : "written off"}: ${stopped.message}`);
      await releaseStopped(ctx, executionId, execution, publish);
      return { do: "stopped", executionId, error: stopped };
    }
    const scope = runScope(ctx.team, executionId);
    // A pinned definition that no longer loads, or an edge whose condition
    // cannot be evaluated against what a node answered, is the run's failure
    // and ends it. Left to throw, it wedged the run instead: every later
    // `gate next` and `gate continue` threw the same error, nothing recorded
    // a failed step for `continue` to drop, and the run stayed "running".
    let workflow: WorkflowDefinition;
    let position: SessionPosition;
    try {
      workflow = getWorkflow(execution.workflowId, scope);
      position = nextInSession(workflow, steps as ExecutionStepRecord[], execution.input);
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      const error = { code: e.code, message: e.message };
      const nodeId = typeof e.detail?.nodeId === "string" ? e.detail.nodeId : "";
      clearPending(executionId);
      ctx.say(`✗ ${error.message}`);
      await settle(ctx, executionId, execution, steps.length, "failed", error, publish);
      return { do: "failed", executionId, nodeId, error };
    }

    if (position.kind === "failed") {
      clearPending(executionId);
      await settle(ctx, executionId, execution, steps.length, "failed", position.error, publish);
      ctx.say(
        `  the run's history and its branch are kept: \`gate continue ${executionId}\` brings the worktree back and tries "${position.nodeId}" again`,
      );
      return { do: "failed", executionId, nodeId: position.nodeId, error: position.error };
    }
    if (position.kind === "done") {
      clearPending(executionId);
      const workspace = workspaceOf(execution);
      await settle(ctx, executionId, execution, steps.length, position.status, null, publish);
      return {
        do: "done",
        executionId,
        status: position.status,
        branch: workspace?.branch ?? null,
        workspace: workspace && existsSync(workspace.root) ? workspace.root : null,
        review: workspace ? reviewCommand(workspace) : null,
      };
    }

    const node = position.node;
    // Only a running run is walked forward. A run that failed without a
    // failed step — it never got its worktree, say — still has a node ahead
    // of it in the graph, and walking to it ran that node's commands on a run
    // the gate had already closed.
    if (execution.status !== "running") {
      const error = execution.error ?? { code: "EXECUTION_NOT_RESUMABLE", message: `this run is ${execution.status}` };
      ctx.say(`this run is ${execution.status}; nothing more of it runs`);
      return { do: "failed", executionId, nodeId: node.id, error };
    }
    // A workflow that works in a worktree runs nowhere else. Without one on
    // the record, a command node's working directory fell back to wherever
    // this process was started — the person's own checkout — and the run's
    // commit and push landed on their current branch.
    if (workflow.workspace && !workspaceOf(execution)) {
      const error = {
        code: "WORKSPACE_ERROR",
        message: "this run has no worktree — it ended before one was made — so none of it can run: start the workflow again",
      };
      clearPending(executionId);
      await settle(ctx, executionId, execution, steps.length, "failed", error, publish);
      return { do: "failed", executionId, nodeId: node.id, error };
    }
    const state = stateFor(execution, position.outputs, position.visitCounts);

    if (node.type === "agent") {
      // Everything the node needs is settled before it is announced: an input
      // nobody produced or a skill this machine does not have fails the node
      // as a recorded step, which ends the run and leaves `gate continue` a
      // step to drop. Announced first, a person's node paused the run and then
      // threw, and a paused run is never written off.
      let prepared: ReturnType<typeof prepareAgentNode>;
      let skills: SkillRef[];
      try {
        prepared = prepareAgentNode(node, state, (id) => getAgent(id, scope));
        skills = resolveSkills(prepared.agent, node.id, scope, ctx.team, executionId);
      } catch (e) {
        if (!(e instanceof WorkflowError)) throw e;
        const at = Date.now();
        clearPending(executionId);
        ctx.say(`✗ ${node.id}: ${e.message}`);
        await record(ctx, executionId, {
          nodeId: node.id,
          stepIndex: position.stepIndex,
          visit: position.visit,
          status: "failed",
          startedAt: at,
          finishedAt: at,
          input: null,
          output: null,
          error: { code: e.code, message: e.message },
        });
        continue;
      }
      // A `gate next` repeated while the session still holds this node — it
      // lost the thread, or asked where the run was — hands the same node
      // out again as it was: same start time, and no second announcement.
      // Re-marking it would restart the node's clock and pause the run twice.
      const held = readPending(executionId);
      const again = held && held.nodeId === node.id && held.visit === position.visit ? held : null;
      const startedAt = again?.startedAt ?? Date.now();
      const workspace = workspaceOf(execution);

      // Said now, not when the answer comes back. A node a session works on
      // takes as long as the work takes, and until this the run looked idle:
      // the dashboard lit the node up only once it was already over, and the
      // terminal said nothing at all about whose turn it was.
      // A node the person answers pauses the run in the same breath: the
      // dashboard says so and the run's clock stops, because from here until
      // `gate step` the time is theirs.
      const personsTurn = asksPerson(prepared.agent);
      // Said again when the last attempt to say it did not arrive: a person's
      // turn the gate never heard of is a run whose clock keeps going and
      // which the silence sweep can write off while they are thinking.
      if (!again || again.unannounced) {
        let announced = true;
        await ctx.client
          .report(executionId, {
            events: [
              {
                type: "node.started",
                at: startedAt,
                nodeId: node.id,
                stepIndex: position.stepIndex,
                visit: position.visit,
              },
              ...(personsTurn ? [{ type: "run.paused", at: startedAt, nodeId: node.id }] : []),
            ],
            steps: [],
          })
          .catch(() => {
            announced = false;
          });
        writePending({
          executionId,
          nodeId: node.id,
          stepIndex: position.stepIndex,
          visit: position.visit,
          startedAt,
          ...(announced ? {} : { unannounced: true as const }),
        });
      }
      ctx.say(
        `▸ ${node.id} · agent ${prepared.agent.id} (${prepared.agent.model}` +
          `${prepared.agent.effort ? `/${prepared.agent.effort}` : ""})` +
          `${position.visit > 1 ? ` · pass ${position.visit}` : ""}${again ? " · still yours" : ""}`,
      );
      if (workspace) ctx.say(`  in ${workspace.root}`);
      if (personsTurn) ctx.say("  the user's turn · the run is paused until they answer");
      if (prepared.agent.executor === "claude-code") {
        // Not the session's own model: a subagent of the session, in the
        // agent's model on the person's own login, drawn live where they are
        // looking.
        const shape = outputShape(prepared.agent.output);
        const subagent = subagentName(ctx.team, prepared.agent.id);
        const outputFile = outputFileFor(executionId, node.id, position.visit);
        // The same node again — a planner after the person's answers, an
        // implementer after a bounded fix — is the same subagent continued,
        // with everything it read still in its context. Only when this run
        // saw it before; the file says.
        const resume = position.visit > 1 ? recallSubagent(executionId, node.id) : null;
        // A continued subagent is sent what moved, not the whole brief over
        // again. `--full` is the way back to the whole brief, for the one case
        // that needs it: the subagent is gone and this node has to be started
        // from nothing.
        let delta: string | null = null;
        if (resume && !opts.full) {
          const before = stateBeforePreviousVisit(workflow, steps as ExecutionStepRecord[], node.id, position.stepIndex);
          if (before) {
            try {
              const earlier = prepareAgentNode(node, stateFor(execution, before.outputs, before.visitCounts), (id) =>
                getAgent(id, scope),
              );
              delta = resumePrompt(
                node.id,
                position.visit,
                node.inputs ?? prepared.agent.inputs,
                prepared.inputs,
                earlier.inputs,
              );
            } catch {
              // The earlier pass cannot be reconstructed — a definition edited
              // between runs, an input that no longer resolves. Send it all.
              delta = null;
            }
          }
        }
        ctx.say(
          `  as subagent ${subagent} in ${prepared.agent.model} · live in this session` +
            (resume ? ` · continuing ${resume}${delta ? " · sending what is new" : ""}` : ""),
        );
        return {
          do: "delegate",
          executionId,
          nodeId: node.id,
          agent: prepared.agent.id,
          model: prepared.agent.model,
          subagent,
          resume,
          prompt: delta
            ? `${delta}\n\n${answerFileNotice(outputFile, shape)}`
            : `${prepared.prompt}\n\n${unattendedNotice()}\n\n${answerFileNotice(outputFile, shape)}`,
          outputFile,
          output:
            prepared.agent.output.type === "json"
              ? { type: "json", schema: prepared.agent.output.schema }
              : { type: "text" },
          workspace: workspace?.root ?? null,
          skills,
          timeoutMs: prepared.agent.timeoutMs ?? null,
          remember: [
            resume
              ? `This node ran earlier in this run as subagent ${resume}. Continue that same agent with SendMessage ` +
                `(to: "${resume}"), giving it \`prompt\` whole and unchanged as the message: it keeps everything it ` +
                (delta
                  ? "read and decided last time, and the prompt is only what has changed since — the answers, the " +
                    "feedback, the gaps. It is deliberately not the whole brief again, so it is no use to a fresh " +
                    `agent. If the send fails because that agent is gone, run \`gate next ${executionId} --full\` ` +
                    "for the whole brief and start the node over with that."
                  : "read and decided last time. If the send fails because that agent is gone, start " +
                    `"${subagent}" fresh with the Agent tool and this same prompt instead.`)
              : `Start the subagent named "${subagent}" with the Agent tool, in the foreground, and give it \`prompt\` ` +
                "as its task, whole and unchanged, followed by the lines below. Do not do the node yourself, and do not " +
                "pick a model for it: its file sets the agent's own model.",
            workspace
              ? `Tell it: work in ${workspace.root} — the run's worktree, not the user's checkout — with absolute paths under it, and nowhere else.`
              : "Tell it: this node has no workspace; reason over the task, touch no files.",
            ...(skills.length
              ? [
                  `Tell it: read and follow, before starting, ${skills.length === 1 ? "this skill" : "these skills"}: ` +
                    skills.map((s) => `${s.id} (${s.path ?? "not pulled"})`).join(", ") +
                    ". They are part of the node.",
                ]
              : []),
            `Tell it: end the final message with ${shape}, and nothing after it.`,
            "It cannot ask the user anything. Do not answer for it either; what it needs settled goes into its answer the way the prompt says.",
            `The prompt tells it to write that answer to ${outputFile} itself. The moment it returns, hand that file back ` +
              "as it is — before telling the user anything, and without retyping it — naming the subagent so the next " +
              "pass of this node can continue it:",
            `  gate step ${executionId} ${node.id} --output-file ${outputFile} --subagent <its agent id>`,
            `The agent id is the short opaque id the Agent tool returned in its result. It is not "${subagent}": that ` +
              "is the type you started, and sending to it resolves to nobody, so the next pass would start over from " +
              "nothing. `gate step` refuses that name rather than storing it.",
            "If the file is not there, take the answer from its final message, write it to that path, and hand it back the same way.",
          ],
        };
      }

      const shape = outputShape(prepared.agent.output);
      const outputFile = outputFileFor(executionId, node.id, position.visit);
      return {
        do: "agent",
        executionId,
        nodeId: node.id,
        agent: prepared.agent.id,
        prompt: prepared.prompt,
        outputFile,
        asks: personsTurn ? askKind(prepared.agent) : null,
        skills,
        remember: [
          ...(skills.length
            ? [
                `This agent follows ${skills.length === 1 ? "a skill" : "skills"}: ` +
                  `${skills.map((s) => s.id).join(", ")}. Open each one's SKILL.md and follow it — ` +
                  "it is part of the node, not a suggestion. If a skill asks you to talk to the user, do that; " +
                  "you are in their session and that is why the node runs here.",
              ]
            : []),
          workspace
            ? `Work in ${workspace.root} — the run's worktree, not the user's checkout.`
            : "This node has no workspace: work from what the prompt gives you and the commands it names, and touch no files on this machine.",
          "Say what you are doing as you go; the user is watching this happen.",
          "What gate printed above this JSON — the command nodes it ran on the way here and their output — the user " +
            "has not seen: relay those lines to them before you start, as they are.",
          // Whether this node may ask is the agent's own `asks`, not a blanket
          // rule about running in a session. Told to every gate-executor node,
          // "ask the user" reached agents written to decide alone — the
          // unattended road's `decide`, whose prompt says "You ask nobody" in
          // its third sentence — so the instruction and the prompt arrived in
          // the same breath contradicting each other, and which one won was
          // left to the model.
          personsTurn
            ? "Ask the user when the brief does not settle something, or something looks wrong. They can answer. " +
              "Ask with AskUserQuestion, one question at a time, their own words through Other — never with a plain " +
              "message that ends your turn: a question asked that way reaches only this terminal, and a person " +
              "watching several runs from elsewhere never sees it."
            : "This node does not ask the user: its agent declares no `asks`, so nothing here pauses for a person. " +
              "When the brief does not settle something, settle it on what you can read and say in your answer what " +
              "you decided and why. If you find something genuinely wrong, that too goes in the answer — the edges " +
              "read it, and that is how the run is stopped.",
          ...(prepared.agent.tools.some((t) => t.startsWith("memory_"))
            ? [
                "This agent reads the team's memory, and here the memory tools are commands: `gate memory search \"<words>\"` " +
                  "and `gate memory search --path <prefix>` are memory_search, `gate memory feature <id>` is memory_feature, " +
                  "`gate memory history --path <prefix>` is memory_history. " +
                  "Run them, read what they print, and treat it as the tool's result. They read only; nothing you do here writes memory.",
              ]
            : []),
          `When the work is done, write ${shape} to ${outputFile} and hand it back:`,
          `  gate step ${executionId} ${node.id} --output-file ${outputFile}`,
        ],
        output:
          prepared.agent.output.type === "json"
            ? { type: "json", schema: prepared.agent.output.schema }
            : { type: "text" },
        workspace: workspace?.root ?? null,
        tools: prepared.agent.tools,
        timeoutMs: prepared.agent.timeoutMs ?? null,
      };
    }

    // Everything else is gate's own work: run it, record it, go round again.
    await runControlNode(ctx, executionId, node, state, position, workspaceOf(execution));
  }
}

/**
 * The outputs and visit counts a node saw the last time it ran.
 *
 * Folded straight off the recorded steps rather than by walking the graph
 * again: the steps are linear and each one's output is assigned under its
 * node id, exactly as `walk` does it, so the fold up to the step before this
 * node's previous visit is what that visit was handed. Null when the node has
 * not run in this execution yet.
 */
function stateBeforePreviousVisit(
  workflow: WorkflowDefinition,
  steps: ExecutionStepRecord[],
  nodeId: string,
  stepIndex: number,
): { outputs: Record<string, unknown>; visitCounts: Record<string, number> } | null {
  let previous = -1;
  for (let i = 0; i < stepIndex && i < steps.length; i++) {
    if (steps[i].nodeId === nodeId) previous = i;
  }
  if (previous < 0) return null;
  const outputs: Record<string, unknown> = {};
  const visitCounts: Record<string, number> = {};
  for (let i = 0; i < previous; i++) {
    visitCounts[steps[i].nodeId] = (visitCounts[steps[i].nodeId] ?? 0) + 1;
    const node = findNode(workflow, steps[i].nodeId);
    // Control nodes route; they contribute no state an agent can read.
    if (!node || node.type === "condition" || node.type === "parallel") continue;
    outputs[steps[i].nodeId] = steps[i].output;
  }
  // That pass counted itself, as every pass does.
  visitCounts[nodeId] = (visitCounts[nodeId] ?? 0) + 1;
  return { outputs, visitCounts };
}

/** An input that was filled on the last pass and is empty on this one. */
const CLEARED = Symbol("cleared");

function readResolved(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const segment of path.split(".").filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function renderValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}

/**
 * What a node's next pass is sent, when the subagent that did the last one is
 * still there holding everything it read.
 *
 * The whole prompt used to go again — the agent's entire body, the task, and
 * every input whether or not it had moved. Measured on one run: 52,146
 * characters re-sent to deliver about 4,500 characters of genuinely new
 * material, and a 250-second gap in the driving session while it was
 * assembled and relayed. The session contract has claimed since it was
 * written that "the prompt carries what is new"; this is the half of it that
 * was never implemented.
 *
 * Only declared inputs are compared, because they are the only thing that can
 * have changed: the agent's body is fixed and the run's input is fixed. An
 * input that went from empty to filled — the answers, the feedback, the gaps
 * — is what a second pass exists for, and is all that is sent. One that went
 * the other way is sent too, as cleared: the subagent still holds last pass's
 * gaps, and told only that everything it was given still holds, it went on
 * treating feedback that had since been answered as open.
 *
 * Null when nothing can be shown to have moved. The caller then sends the
 * whole prompt: a pass that cannot say what is new has no business claiming
 * to be a continuation.
 */
function resumePrompt(
  nodeId: string,
  visit: number,
  paths: string[],
  current: Record<string, unknown>,
  previous: Record<string, unknown>,
): string | null {
  const isEmpty = (v: unknown) => v === undefined || v === "" || v === null || (Array.isArray(v) && !v.length);
  const changed: Array<[string, unknown]> = [];
  for (const raw of paths) {
    const path = raw.replace(/\?$/, "");
    const now = readResolved(current, path);
    const then = readResolved(previous, path);
    if (isEmpty(now)) {
      if (!isEmpty(then)) changed.push([path, CLEARED]);
      continue;
    }
    if (JSON.stringify(now) === JSON.stringify(then)) continue;
    changed.push([path, now]);
  }
  if (!changed.length) return null;
  return (
    `Pass ${visit} of the "${nodeId}" node — the same node you worked on before, continued.\n\n` +
    "The task, the brief, and what you read and decided while doing it still hold. Do not start the " +
    "node over and do not ask for any of it again; go on from where you left off. What follows is " +
    "every input that moved since your last pass — one marked cleared was answered or withdrawn and " +
    "no longer applies.\n\nWhat is new since your last pass:\n\n" +
    changed
      .map(([path, value]) =>
        value === CLEARED
          ? `## ${path}\n\n(cleared — what you were given here last time no longer applies)`
          : `## ${path}\n\n${renderValue(value)}`,
      )
      .join("\n\n")
  );
}

/**
 * The answer's shape, in words, for whoever is about to write it.
 *
 * The bare notation used to be handed over as it stands — `gaps (string?)` —
 * next to "exactly these keys", which reads as an instruction to write every
 * key, and leaves the model to guess what the `?` licenses. One guessed
 * `null`, which the validator then refused, and a finished verification was
 * thrown away over its punctuation. So the notation is glossed here rather
 * than quoted: optional is spelled out, and both spellings of "nothing to
 * say" are named.
 */
function outputShape(output: { type: "json"; schema: Record<string, string> } | { type: "text" }): string {
  if (output.type !== "json") return "the answer as plain text";
  const fields = Object.entries(output.schema)
    .map(([key, type]) => (type.endsWith("?") ? `${key} (${type.slice(0, -1)}, optional)` : `${key} (${type})`))
    .join(", ");
  const anyOptional = Object.values(output.schema).some((type) => type.endsWith("?"));
  return (
    `a JSON object with these keys: ${fields}` +
    (anyOptional
      ? " — an optional key may be left out or written as null when there is nothing to say, and every other key is required"
      : ", and nothing else")
  );
}

/**
 * Told to a subagent at the end of its task: where its answer goes. The
 * session used to copy the answer out of the subagent's final message into
 * a file by hand — ten kilobytes retyped through the session's own context,
 * a minute or two per node, and one chance per node to drop a character.
 */
function answerFileNotice(outputFile: string, shape: string): string {
  return (
    `When you are done, write your answer — ${shape}, exactly what your final message ends with, and nothing ` +
    `else — to the file ${outputFile} (create the directory if it is missing), then end your final message with ` +
    "that same answer. The file is what the run reads; the message is for the person watching."
  );
}

/**
 * Whether a node is the person's to answer, here in the session. Only an
 * agent the session itself runs can be: a headless one cannot ask anybody,
 * whatever its file says.
 */
function asksPerson(agent: { asks?: AsksValue; executor: string }): boolean {
  return agent.asks !== undefined && agent.executor === "gate";
}

type AsksValue = "person" | "question" | "approval";

/** What kind of turn a person's node is; the older `person` is a question. */
function askKind(agent: { asks?: AsksValue }): "question" | "approval" | null {
  if (agent.asks === undefined) return null;
  return agent.asks === "approval" ? "approval" : "question";
}

/**
 * The reason a run stopped being `running` without this session's doing —
 * null for a run still going, or one the walk itself settled.
 */
function stoppedOutside(execution: { status: string; error: { code: string; message: string } | null }): {
  code: string;
  message: string;
} | null {
  if (execution.status === "running" || !execution.error) return null;
  return execution.error.code === "RUN_CANCELLED" || execution.error.code === "RUN_ABANDONED" ? execution.error : null;
}

/**
 * The skills an agent declares, found on this machine.
 *
 * The run's pin is read first, and the team's mirror after it: a skill is the
 * process an agent follows, not part of the graph the pin keeps still, and a
 * skill the pin never got — imported after the run began, or missing when it
 * did — is otherwise one no `gate pull` could ever supply to this run.
 */
function resolveSkills(
  agent: AgentDefinition,
  nodeId: string,
  scope: DefinitionScope,
  team: string,
  executionId: string,
): SkillRef[] {
  return agent.skills.map((id) => {
    for (const where of [scope, cacheScope(team)]) {
      try {
        return { id, description: getSkill(id, where).description, path: resolveSkillDir(id, where) };
      } catch {
        // Not here; the mirror next.
      }
    }
    throw new WorkflowError(
      "AGENT_DEFINITION_INVALID",
      `node "${nodeId}": agent "${agent.id}" declares skill "${id}", which this machine did not pull — ` +
        `run \`gate pull\` (and check it is in your team's skill library), then \`gate continue ${executionId}\``,
      { nodeId, agentId: agent.id },
    );
  });
}

/** A state the condition language and the input resolver can read. */
function stateFor(
  execution: { workflowId: string; input: Record<string, unknown> },
  outputs: Record<string, unknown>,
  visitCounts: Record<string, number>,
): WorkflowState {
  return {
    executionId: "",
    workflowId: execution.workflowId,
    status: "running",
    input: execution.input,
    outputs,
    // What `visits.<node>` reads, in an agent's inputs and a command's argv.
    // Left empty, every one of them read 0: the conflict-review told the
    // planner's objection came from visit 0 matched no objection the planner
    // had raised, and the person's confirmation of it never landed.
    visitCounts,
    stepCount: 0,
    history: [],
    error: null,
  };
}

/** Runs a command / condition / parallel node here and records its step. */
async function runControlNode(
  ctx: SessionRunContext,
  executionId: string,
  node: Extract<WorkflowDefinition["nodes"][number], { type: string }>,
  state: WorkflowState,
  position: { visit: number; stepIndex: number },
  workspace: RunWorkspace | null,
): Promise<void> {
  const startedAt = Date.now();
  let input: unknown = null;
  let output: unknown = null;
  let error: { code: string; message: string } | undefined;

  try {
    if (node.type === "command") {
      // Rendered here, where the state is — the same substitution the engine
      // does, so a command carrying an upstream output means the same thing.
      const command = node.command.map((arg: string) =>
        arg.includes("{{") ? renderTemplate(arg, conditionContext(state)) : arg,
      );
      input = command;
      ctx.say(`$ ${command.join(" ")}`);
      const result = (await runCommand({ ...node, command }, { defaultCwd: workspace?.root })) as {
        ok: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      output = result;
      // The point of running it here rather than in a session: it is visible.
      if (result.stdout.trim()) ctx.say(result.stdout.trimEnd());
      if (result.stderr.trim()) ctx.say(result.stderr.trimEnd());
      ctx.say(result.ok ? `✓ ${node.id}` : `✗ ${node.id} (exit ${result.exitCode})`);
    } else if (node.type === "parallel") {
      input = { branches: node.branches, join: node.join };
      ctx.say(`▸ ${node.id}: ${node.branches.join(", ")} — one after another in this session`);
    } else {
      ctx.say(`▸ ${node.id}`);
    }
  } catch (e) {
    error = { code: e instanceof WorkflowError ? e.code : "COMMAND_FAILED", message: (e as Error).message };
    ctx.say(`✗ ${node.id}: ${error.message}`);
  }

  await record(ctx, executionId, {
    nodeId: node.id,
    stepIndex: position.stepIndex,
    visit: position.visit,
    status: error ? "failed" : "completed",
    startedAt,
    finishedAt: Date.now(),
    input,
    output,
    ...(error ? { error } : {}),
  });
}

/** Takes the session's answer for the node it was given. */
export async function step(
  ctx: SessionRunContext,
  executionId: string,
  nodeId: string,
  answer: string,
  opts: { subagent?: string } = {},
): Promise<Instruction> {
  return withRunLock(executionId, () => takeAnswer(ctx, executionId, nodeId, answer, opts));
}

async function takeAnswer(
  ctx: SessionRunContext,
  executionId: string,
  nodeId: string,
  answer: string,
  opts: { subagent?: string },
): Promise<Instruction> {
  const pending = readPending(executionId);
  if (!pending || pending.executionId !== executionId) {
    throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `nothing is waiting on an answer for run ${executionId}`);
  }
  if (pending.nodeId !== nodeId) {
    throw new WorkflowError(
      "WORKFLOW_ROUTING_ERROR",
      `this run is waiting on "${pending.nodeId}", not "${nodeId}" — run \`gate next ${executionId}\` to see what it wants`,
    );
  }
  // `--subagent` is what the next pass of this node is resumed with, and only
  // the agent id the Agent tool returned resolves. The type name — what
  // `~/.claude/agents/` calls the file, which gate itself wrote — never does,
  // and nothing downstream notices: the value is stored, the next pass sends
  // to a name that is not an address, the send fails, and a fresh subagent
  // reads everything again. Measured in one run: the verifier's subtree read
  // the plan file fourteen times and one source file eleven. The test is
  // exact, because the wrong value is always this prefix. Refused here, before
  // the step is recorded, so that a refused step is a step that did not run
  // and can be handed back with the right id.
  const mirrorPrefix = subagentName(ctx.team, "");
  if (opts.subagent?.startsWith(mirrorPrefix)) {
    throw new WorkflowError(
      "WORKFLOW_ROUTING_ERROR",
      `--subagent takes the agent id the Agent tool returned — the short opaque id in its result — not ` +
        `"${opts.subagent}", which is the subagent's type name in ~/.claude/agents/. Resuming by type name ` +
        `spawns a fresh subagent on every pass, which reads the whole worktree again. Hand this step back with ` +
        `that id, or without --subagent at all if you no longer have it.`,
    );
  }

  const { execution, publish } = await ctx.client.execution(executionId);
  // Stopped while the answer was being worked out: the answer has nowhere to
  // go, and saying so beats recording a step on a run that has ended.
  const stopped = stoppedOutside(execution);
  if (stopped) {
    clearPending(executionId);
    ctx.say(`■ run ${stopped.code === "RUN_CANCELLED" ? "stopped" : "written off"}: ${stopped.message}`);
    await releaseStopped(ctx, executionId, execution, publish);
    return { do: "stopped", executionId, error: stopped };
  }
  const scope = runScope(ctx.team, executionId);
  const workflow = getWorkflow(execution.workflowId, scope);
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== "agent") {
    throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `node "${nodeId}" does not take an answer`);
  }
  const agent = getAgent(node.agent, scope);

  // Validated exactly as the engine validates a model's answer: a node whose
  // output does not match what it declared is a failed node, not a surprise
  // three nodes later.
  const output = parseOutput(agent, answer, nodeId);

  const finishedAt = Date.now();
  await record(
    ctx,
    executionId,
    {
      nodeId,
      stepIndex: pending.stepIndex,
      visit: pending.visit,
      status: "completed",
      startedAt: pending.startedAt,
      finishedAt,
      input: null,
      output,
      // Done by the session, or by its subagent, on the person's own login:
      // nothing here sees what it cost.
      costing: "session",
    },
    false,
    // The person has answered: the run is working again, from this moment.
    asksPerson(agent) ? [{ type: "run.resumed", at: finishedAt, nodeId }] : [],
  );
  ctx.say(`✓ ${nodeId} (${Math.max(1, Math.round((finishedAt - pending.startedAt) / 1000))}s)`);
  // Which subagent did it, for the next pass of this node to continue.
  if (opts.subagent) rememberSubagent(executionId, nodeId, opts.subagent);
  clearPending(executionId);
  return next(ctx, executionId);
}

/** Sends one step up, so the dashboard has it as it happens. */
async function record(
  ctx: SessionRunContext,
  executionId: string,
  step: StepRecord,
  /** False for a node whose start was announced when it was handed out. */
  announceStart = true,
  /** Anything else this report should say first — a run resuming, say. */
  also: Array<Record<string, unknown>> = [],
): Promise<void> {
  const res = await ctx.client.report(executionId, {
    events: [
      ...also,
      ...(announceStart
        ? [
            {
              type: "node.started",
              at: step.startedAt,
              nodeId: step.nodeId,
              stepIndex: step.stepIndex,
              visit: step.visit,
            },
          ]
        : []),
      step.status === "failed"
        ? {
            type: "node.failed",
            at: step.finishedAt,
            nodeId: step.nodeId,
            stepIndex: step.stepIndex,
            code: step.error?.code,
            message: step.error?.message,
          }
        : {
            type: "node.completed",
            at: step.finishedAt,
            nodeId: step.nodeId,
            stepIndex: step.stepIndex,
            durationMs: step.finishedAt - step.startedAt,
          },
    ],
    steps: [step],
  });
  if (res.cancelRequested) {
    ctx.say("stop requested from the dashboard");
    throw new WorkflowError("RUN_CANCELLED", "run cancelled");
  }
}

/** Closes the run out, with the diff its worktree holds. */
async function settle(
  ctx: SessionRunContext,
  executionId: string,
  execution: { workspace: RunWorkspace | null; status: string },
  stepCount: number,
  status: "completed" | "failed",
  error: { code: string; message: string } | null,
  /** Where this run's repository publishes, as the gate answered on this poll. */
  publish?: PublicationTarget | null,
): Promise<void> {
  const workspace = workspaceOf(execution);
  if (execution.status === "running") {
    let diff: string | null = null;
    let summary = null;
    if (workspace && existsSync(workspace.root)) {
      summary = summarizeWorkspace(workspace);
      try {
        diff = readRunDiff(workspace.root, workspace.baseCommit).diff;
      } catch {
        // A worktree removed mid-run is the run's own failure, not a second one.
      }
    }
    // The gate has to hear the outcome before anything is taken away. Told
    // "done" while the row stayed running, the session moved on, the
    // worktree and the pin went, and six hours later a finished run was
    // written off as abandoned — and a `gate next` to put it right walked a
    // graph the pin no longer held and reported no diff.
    try {
      await ctx.client.finish(executionId, { status, error, stepCount, workspace: summary, diff });
    } catch (e) {
      throw new WorkflowError(
        "WORKSPACE_ERROR",
        `could not report the run's outcome to the gate (${(e as Error).message}); its worktree and definitions are ` +
          `kept — run \`gate next ${executionId}\` again once the gate answers`,
      );
    }
  }

  // Ended either way: the worktree goes and its branch keeps the work — a
  // failed run's `gate continue` checks it out again from there. A run the
  // gate had already closed gets here too, when the report of its end went
  // through and the answer to it did not; releasing a worktree that is
  // already gone does nothing.
  if (workspace) await releaseAndPublish(ctx.client, workspace, executionId, publish, ctx.say);
  // Over for good: the pinned definitions and the logs have nothing left to
  // serve. A failed run keeps them, because `gate continue` needs them.
  if (status === "completed") forgetRun(executionId);
}

/** A run stopped from outside ends like any other: its worktree goes, its branch stays. */
async function releaseStopped(
  ctx: SessionRunContext,
  executionId: string,
  execution: { workspace: RunWorkspace | null },
  publish?: PublicationTarget | null,
): Promise<void> {
  const workspace = workspaceOf(execution);
  if (workspace) await releaseAndPublish(ctx.client, workspace, executionId, publish, ctx.say);
}

/**
 * Picks a failed run back up at the node it failed on, in the same worktree.
 *
 * The server drops the failed attempt from the history and marks the run as
 * running again; the next walk then lands on that node as if it had never
 * run, with everything before it kept — a failed reviewer is retried, not
 * the implementer that preceded it. Anything this machine still held for the
 * node — the marker of the node it was handed — is cleared first, so the
 * retry starts clean. The worktree went when the run ended; it is checked
 * out again from the run's branch, at the same path, before anything runs.
 */
export async function continueRun(ctx: SessionRunContext, executionId: string): Promise<Instruction> {
  return withRunLock(executionId, () => reopen(ctx, executionId));
}

async function reopen(ctx: SessionRunContext, executionId: string): Promise<Instruction> {
  const { execution } = await ctx.client.execution(executionId);
  if (execution.driver !== "session") {
    throw new WorkflowError(
      "EXECUTION_NOT_RESUMABLE",
      "only a run /gate:run drove can be continued; start this one again with /gate:run",
    );
  }
  if (execution.status === "running") return next(ctx, executionId);
  if (execution.status !== "failed") {
    throw new WorkflowError("EXECUTION_NOT_RESUMABLE", `this run ${execution.status}; there is nothing to continue`);
  }
  const workspace = workspaceOf(execution);
  // A run that ended before its worktree was made has nothing to continue
  // in. Reopened anyway, its command nodes ran wherever this was typed — the
  // person's own checkout, their current branch.
  if (!workspace && getWorkflow(execution.workflowId, runScope(ctx.team, executionId)).workspace) {
    throw new WorkflowError(
      "EXECUTION_NOT_RESUMABLE",
      "this run ended before its worktree was made, so there is nothing to continue: start the workflow again",
    );
  }
  let restored = false;
  if (workspace && !existsSync(workspace.root)) {
    try {
      restored = restoreRunWorkspace(workspace);
      borrowDependencies(workspace);
    } catch (e) {
      throw new WorkflowError(
        "EXECUTION_NOT_RESUMABLE",
        `the worktree this run used (${workspace.root}) is gone and could not be brought back from branch ${workspace.branch}: ${(e as Error).message}; start the workflow again instead`,
      );
    }
  }

  clearPending(executionId);

  const reopened = await ctx.client.continueRun(executionId);
  if (!reopened.continued) {
    if (restored && workspace) releaseRunWorkspace(workspace, executionId);
    throw new WorkflowError("EXECUTION_NOT_RESUMABLE", reopened.reason ?? "this run cannot be continued");
  }
  if (restored && workspace) ctx.say(`worktree ${workspace.root} brought back from branch ${workspace.branch}`);
  ctx.say(
    reopened.retried?.length
      ? `▸ continuing ${executionId}: ${reopened.retried.join(", ")} will run again; everything before it stands`
      : `▸ continuing ${executionId}`,
  );
  return next(ctx, executionId);
}
