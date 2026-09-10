import { spawn } from "node:child_process";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { getAgent } from "@/agents/registry";
import type { ExecutionStepRecord } from "@/executions/types";
import { scopeAt, type DefinitionScope } from "@/lib/def-root";
import { parseOutput, prepareAgentNode } from "@/runtime/executors/agent";
import { runClaudeCodeNode } from "@/runtime/executors/claude-code";
import { runCommand } from "@/runtime/executors/command";
import { WorkflowError } from "@/runtime/errors";
import type { StepRecord, WorkflowState } from "@/runtime/state";
import { renderTemplate } from "@/agents/template";
import { conditionContext } from "@/runtime/state";
import {
  borrowDependencies,
  createRunWorkspace,
  readRunDiff,
  summarizeWorkspace,
  tidyRunWorkspace,
  type RunWorkspace,
} from "@/runtime/workspace";
import { unattendedNotice } from "@/skills/inject";
import { getSkill, resolveSkillDir } from "@/skills/registry";
import type { SkillDefinition } from "@/skills/types";
import { getWorkflow } from "@/workflows/registry";
import type { WorkflowDefinition } from "@/workflows/types";

import type { GateClient } from "./api";
import { CLI_VERSION } from "./api";
import { RunReporter } from "./reporter";
import { subagentName } from "./subagents";
import { describeCall, describeText } from "./worker-log";
import { cacheDir, cacheScope } from "./cache";
import { gateHome } from "./config";
import { resolveRepo } from "./run";
import { nextInSession } from "./walk";

/**
 * The environment variable the plugin's SessionStart hook sets, carrying the
 * Claude Code session's id. Read here so a run can say which session drives
 * it, which is what lets the gateway's record of that session's own calls be
 * costed against the nodes the session did itself.
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
 * this runs them itself and moves on. Agent nodes split by executor, the same
 * way they do on the server. `executor: gate` means the loop driving the run,
 * which here is the session: it gets the node, in front of the user, and can
 * ask them. `executor: claude-code` means a spawned Claude Code in the agent's
 * own model — a planner on GLM, an implementer on a local model — which the
 * session's model cannot stand in for. That node is run by this CLI as a
 * detached worker (`gate work`), its tool calls written to a log the session
 * follows with `gate wait` and relays to the person; the worker records the
 * step itself when it is done, and the session carries on from there.
 */

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
      skills: Array<{ id: string; description: string; path: string | null }>;
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
       * A node running on its own, in its own model. The session has nothing
       * to do for it but follow along: `gate wait` prints what the worker is
       * doing and comes back with the next instruction when it is done.
       */
      do: "wait";
      executionId: string;
      nodeId: string;
      agent: string;
      model: string;
      /** Where the worker writes what it is doing, one tool call per line. */
      log: string;
      startedAt: number;
      remember: string[];
    }
  | {
      /**
       * A node in its own model, run as a subagent of the session so that it
       * is drawn live in the terminal. Only when the session itself goes
       * through the gateway: the subagent inherits the session's endpoint,
       * and its model is a name only the gateway resolves.
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
      skills: Array<{ id: string; description: string; path: string | null }>;
      timeoutMs: number | null;
      remember: string[];
    }
  | { do: "done"; executionId: string; status: "completed" | "failed"; branch: string | null; workspace: string | null }
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
  /** Set when the node is being run by a detached worker rather than the session. */
  worker?: { pid: number; log: string };
  /** How much of the log `gate wait` has already shown. */
  shown?: number;
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

export interface SessionRunContext {
  client: GateClient;
  team: string;
  /** Printed for the person watching; the session's own output is the rest. */
  say: (message: string) => void;
  /** Starts the detached worker for a node; the CLI's own process by default. Injectable for tests. */
  spawnWorker?: (executionId: string, nodeId: string, log: string) => number;
  /**
   * The session's own model calls go through the gateway. Then a claude-code
   * node can run as its subagent — live in the terminal — in the agent's
   * model, instead of as a worker the session only follows.
   */
  throughGateway?: boolean;
  /** Handed to the claude-code executor inside the worker, so tests do not spawn a real CLI. */
  spawnCli?: typeof spawn;
}

function logPath(pending: Pick<Pending, "executionId" | "nodeId" | "visit">): string {
  return join(gateHome(), "runs", `${pending.executionId}-${pending.nodeId}-${pending.visit}.log`);
}

/**
 * The worker is this same CLI, run again with `work`, detached: the session's
 * Bash call has to return in minutes, and an implementer node takes an hour.
 * stdout and stderr go to the log, so nothing it prints is lost, and the
 * process is unref'd so the `gate next` that started it can exit.
 */
function spawnDetachedWorker(executionId: string, nodeId: string, log: string): number {
  const fd = openSync(log, "a");
  try {
    const child = spawn(process.execPath, [process.argv[1], "work", executionId, nodeId], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    child.unref();
    if (child.pid === undefined) throw new WorkflowError("MODEL_EXECUTION_ERROR", "could not start the worker process");
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitInstruction(executionId: string, pending: Pending, agent: { id: string; model: string }): Instruction {
  return {
    do: "wait",
    executionId,
    nodeId: pending.nodeId,
    agent: agent.id,
    model: agent.model,
    log: pending.worker!.log,
    startedAt: pending.startedAt,
    remember: [
      `Node "${pending.nodeId}" is running on its own as a spawned Claude Code, in ${agent.model} — the agent's model, not yours. ` +
        "You do nothing for it: do not touch the worktree, do not do its work, do not answer for it.",
      `Follow it with \`gate wait ${executionId}\`. That prints what the node is doing as it happens and returns ` +
        "when the node is done — with the next instruction — or after about ninety seconds, with this one again; " +
        "run it again until it moves on.",
      "Between waits, relay what the log printed, as it is. They are watching this happen.",
      "If the user would rather watch such a node live, every read, edit and command drawn here as your own " +
        "are, tell them once: `/gate:live` puts this repository's Claude Code sessions on the gateway, and " +
        "from then on a node in its own model runs as a subagent of the session instead of a worker.",
    ],
  };
}

/** Starts a run and returns its first instruction. */
export async function begin(
  ctx: SessionRunContext,
  workflowId: string,
  input: Record<string, unknown>,
  cwd: string,
  repos: Record<string, string>,
): Promise<Instruction> {
  const scope = cacheScope(ctx.team);
  const workflow = getWorkflow(workflowId, scope);

  const runInput = { ...input };
  let repo: string | null = null;
  if (workflow.workspace) {
    repo = resolveRepo(workflow, runInput, cwd, repos);
    runInput.repo = repo;
  }

  // The session's id reaches this process through the plugin's hook; without
  // it the run is still fine, only the nodes the session does itself go
  // uncosted.
  // The plugin's session hook, or the id Claude Code itself puts in a tool's
  // environment: either names the session whose gateway calls cost the nodes
  // it does itself.
  const session = (process.env[SESSION_ID_ENV] ?? process.env.CLAUDE_CODE_SESSION_ID ?? "").trim() || undefined;
  const executionId = await ctx.client.startRun({
    workflowId: workflow.id,
    input: runInput,
    client: { host: hostname(), repo: repo ?? undefined, version: CLI_VERSION, session },
    driver: "session",
  });

  // The definitions this run will follow, frozen before anything reads them.
  pinDefinitions(ctx.team, executionId);

  if (workflow.workspace) {
    try {
      const workspace = createRunWorkspace({ ...workflow.workspace, repo: repo! }, executionId);
      ctx.say(`worktree ${workspace.root} on branch ${workspace.branch}`);
      const linked = borrowDependencies(workspace);
      if (linked.length) ctx.say(`  linked ${linked.join(", ")} from ${workspace.repo}`);
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
export async function next(ctx: SessionRunContext, executionId: string): Promise<Instruction> {
  for (;;) {
    const { execution, steps } = await ctx.client.execution(executionId);
    // Settled from outside since this session last looked: Stop on the
    // dashboard lands on the row directly for a run a session drives, and a
    // session that was gone for hours is written off there too. Either way
    // the walk is over, whatever the marker on disk still says — and a worker
    // still running for it is stopped rather than left to finish for nobody.
    const stopped = stoppedOutside(execution);
    if (stopped) {
      const pending = readPending(executionId);
      if (pending?.worker && alive(pending.worker.pid)) {
        try {
          process.kill(pending.worker.pid);
        } catch {
          // Already gone.
        }
      }
      clearPending(executionId);
      ctx.say(`■ run ${stopped.code === "RUN_CANCELLED" ? "stopped" : "written off"}: ${stopped.message}`);
      return { do: "stopped", executionId, error: stopped };
    }
    const scope = runScope(ctx.team, executionId);
    const workflow: WorkflowDefinition = getWorkflow(execution.workflowId, scope);
    const position = nextInSession(workflow, steps as ExecutionStepRecord[], execution.input);

    if (position.kind === "failed") {
      clearPending(executionId);
      await settle(ctx, executionId, execution, steps.length, "failed", position.error);
      ctx.say(`  the worktree and the run's history are kept: \`gate continue ${executionId}\` tries "${position.nodeId}" again`);
      return { do: "failed", executionId, nodeId: position.nodeId, error: position.error };
    }
    if (position.kind === "done") {
      clearPending(executionId);
      const workspace = workspaceOf(execution);
      await settle(ctx, executionId, execution, steps.length, position.status, null);
      return {
        do: "done",
        executionId,
        status: position.status,
        branch: workspace?.branch ?? null,
        workspace: workspace?.root ?? null,
      };
    }

    const node = position.node;
    const state = stateFor(execution, position.outputs);

    if (node.type === "agent") {
      const prepared = prepareAgentNode(node, state, (id) => getAgent(id, scope));
      if (prepared.agent.executor === "claude-code") {
        // Not the session's to do: this node runs in the agent's own model,
        // through the gateway, as a worker this process starts and leaves
        // running. A second `gate next` while it runs finds the worker alive
        // and says so; one that finds it dead with nothing recorded fails the
        // node with the log to look at, rather than starting it over silently.
        // Checked before anything is announced or written: the marker on disk
        // is the only memory of a worker already running, and overwriting it
        // here would start a second one on every `gate next`.
        const already = readPending(executionId);
        if (already && already.worker && already.nodeId === node.id && already.visit === position.visit) {
          if (alive(already.worker.pid)) return waitInstruction(executionId, already, prepared.agent);
          clearPending(executionId);
          await record(
            ctx,
            executionId,
            {
              nodeId: node.id,
              stepIndex: position.stepIndex,
              visit: position.visit,
              status: "failed",
              startedAt: already.startedAt,
              finishedAt: Date.now(),
              input: null,
              output: null,
              error: {
                code: "MODEL_EXECUTION_ERROR",
                message: `the worker running "${node.id}" exited without reporting; its log is ${already.worker.log}`,
              },
            },
            false,
          );
          continue;
        }
      }
      // A `gate next` repeated while the session still holds this node — it
      // lost the thread, or asked where the run was — hands the same node
      // out again as it was: same start time, and no second announcement.
      // Re-marking it would restart the node's clock and pause the run twice.
      const held = readPending(executionId);
      const again = held && !held.worker && held.nodeId === node.id && held.visit === position.visit ? held : null;
      const startedAt = again?.startedAt ?? Date.now();
      if (!again) {
        writePending({
          executionId,
          nodeId: node.id,
          stepIndex: position.stepIndex,
          visit: position.visit,
          startedAt,
        });
      }
      const workspace = workspaceOf(execution);

      // Said now, not when the answer comes back. A node a session works on
      // takes as long as the work takes, and until this the run looked idle:
      // the dashboard lit the node up only once it was already over, and the
      // terminal said nothing at all about whose turn it was.
      // A node the person answers pauses the run in the same breath: the
      // dashboard says so and the run's clock stops, because from here until
      // `gate step` the time is theirs.
      const personsTurn = asksPerson(prepared.agent);
      if (!again) {
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
          .catch(() => {});
      }
      ctx.say(
        `▸ ${node.id} · agent ${prepared.agent.id} (${prepared.agent.model}` +
          `${prepared.agent.effort ? `/${prepared.agent.effort}` : ""})` +
          `${position.visit > 1 ? ` · pass ${position.visit}` : ""}${again ? " · still yours" : ""}`,
      );
      if (workspace) ctx.say(`  in ${workspace.root}`);
      if (personsTurn) ctx.say("  the user's turn · the run is paused until they answer");
      // Named by the agent, resolved on this machine. A skill that has gone
      // missing fails the node here rather than halfway through it.
      const skills = prepared.agent.skills.map((id) => {
        let description = "";
        try {
          description = getSkill(id, scope).description;
        } catch {
          throw new WorkflowError(
            "AGENT_DEFINITION_INVALID",
            `node "${node.id}": agent "${prepared.agent.id}" declares skill "${id}", which this machine did not pull — ` +
              "run `gate pull`, or check it is in your team's skill library",
            { nodeId: node.id, agentId: prepared.agent.id },
          );
        }
        return { id, description, path: resolveSkillDir(id, scope) };
      });

      if (prepared.agent.executor === "claude-code" && ctx.throughGateway) {
        // The session's endpoint is the gateway, so a subagent of the session
        // reaches the agent's model too — and is drawn live where the
        // person is looking, which a worker's log never is.
        const shape =
          prepared.agent.output.type === "json"
            ? `a JSON object with exactly these keys: ${Object.entries(prepared.agent.output.schema)
                .map(([k, t]) => `${k} (${t})`)
                .join(", ")}`
            : "the answer as plain text";
        const subagent = subagentName(ctx.team, prepared.agent.id);
        const outputFile = outputFileFor(executionId, node.id, position.visit);
        // The same node again — a planner after the person's answers, an
        // implementer after a bounded fix — is the same subagent continued,
        // with everything it read still in its context. Only when this run
        // saw it before; the file says.
        const resume = position.visit > 1 ? recallSubagent(executionId, node.id) : null;
        ctx.say(
          `  as subagent ${subagent} in ${prepared.agent.model} · live in this session` +
            (resume ? ` · continuing ${resume}` : ""),
        );
        return {
          do: "delegate",
          executionId,
          nodeId: node.id,
          agent: prepared.agent.id,
          model: prepared.agent.model,
          subagent,
          resume,
          prompt: `${prepared.prompt}\n\n${unattendedNotice()}\n\n${answerFileNotice(outputFile, shape)}`,
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
                "read and decided last time, and the prompt carries what is new — the answers, the feedback. Only if " +
                `the send fails because that agent is gone, start "${subagent}" fresh with the Agent tool instead.`
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
            `  gate step ${executionId} ${node.id} --output-file ${outputFile} --subagent <its agent id or name>`,
            "If the file is not there, take the answer from its final message, write it to that path, and hand it back the same way.",
          ],
        };
      }

      if (prepared.agent.executor === "claude-code") {
        // Not the session's to do: this node runs in the agent's own model,
        // through the gateway, as a worker this process starts and leaves
        // running; the session follows its log with `gate wait`.
        const log = logPath({ executionId, nodeId: node.id, visit: position.visit });
        mkdirSync(join(gateHome(), "runs"), { recursive: true, mode: 0o700 });
        appendFileSync(log, `── ${node.id} · agent ${prepared.agent.id} · ${prepared.agent.model} · started ${new Date(startedAt).toISOString()}\n`, { mode: 0o600 });
        const pid = (ctx.spawnWorker ?? spawnDetachedWorker)(executionId, node.id, log);
        const pending: Pending = {
          executionId,
          nodeId: node.id,
          stepIndex: position.stepIndex,
          visit: position.visit,
          startedAt,
          worker: { pid, log },
          shown: 0,
        };
        writePending(pending);
        ctx.say(`  running on its own in ${prepared.agent.model} · log ${log}`);
        return waitInstruction(executionId, pending, prepared.agent);
      }

      const shape =
        prepared.agent.output.type === "json"
          ? `a JSON object with exactly these keys: ${Object.entries(prepared.agent.output.schema)
              .map(([k, t]) => `${k} (${t})`)
              .join(", ")}`
          : "the answer as plain text";
      const outputFile = outputFileFor(executionId, node.id, position.visit);
      return {
        do: "agent",
        executionId,
        nodeId: node.id,
        agent: prepared.agent.id,
        prompt: prepared.prompt,
        outputFile,
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
            : "This node has no workspace: reason over what the prompt gives you, do not touch files.",
          "Say what you are doing as you go; the user is watching this happen.",
          "What gate printed above this JSON — the command nodes it ran on the way here and their output — the user " +
            "has not seen: relay those lines to them before you start, as they are.",
          "Ask the user when the brief does not settle something, or something looks wrong. They can answer.",
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
function asksPerson(agent: { asks?: "person"; executor: string }): boolean {
  return agent.asks === "person" && agent.executor === "gate";
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

/** A state the condition language and the input resolver can read. */
function stateFor(execution: { workflowId: string; input: Record<string, unknown> }, outputs: Record<string, unknown>): WorkflowState {
  return {
    executionId: "",
    workflowId: execution.workflowId,
    status: "running",
    input: execution.input,
    outputs,
    visitCounts: {},
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

  const { execution } = await ctx.client.execution(executionId);
  // Stopped while the answer was being worked out: the answer has nowhere to
  // go, and saying so beats recording a step on a run that has ended.
  const stopped = stoppedOutside(execution);
  if (stopped) {
    clearPending(executionId);
    ctx.say(`■ run ${stopped.code === "RUN_CANCELLED" ? "stopped" : "written off"}: ${stopped.message}`);
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
      // Done by the session, or by its subagent: the server costs it from
      // the session's own gateway calls, since nothing here can report them.
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

/**
 * Runs one claude-code node to completion, as the detached worker.
 *
 * The same thing the engine does for such a node on the server — the same
 * executor, the same gateway, the same metering — with two differences that
 * come from running here: every tool call also goes to the log the session is
 * following, and the step is recorded by this process, so the run advances
 * whether or not anybody is watching. Stop from the dashboard reaches it the
 * way it reaches a headless run: on the reply to a report.
 */
export async function work(ctx: SessionRunContext, executionId: string, nodeId: string): Promise<boolean> {
  const pending = readPending(executionId);
  if (!pending || pending.nodeId !== nodeId || !pending.worker) {
    throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `run ${executionId} is not waiting on a worker for "${nodeId}"`);
  }
  const { execution, steps } = await ctx.client.execution(executionId);
  const scope = runScope(ctx.team, executionId);
  const workflow: WorkflowDefinition = getWorkflow(execution.workflowId, scope);
  const position = nextInSession(workflow, steps as ExecutionStepRecord[], execution.input);
  if (position.kind !== "node" || position.node.id !== nodeId || position.node.type !== "agent") {
    throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `run ${executionId} is not at "${nodeId}"`);
  }
  const node = position.node;
  const prepared = prepareAgentNode(node, stateFor(execution, position.outputs), (id) => getAgent(id, scope));
  const skills: SkillDefinition[] = prepared.agent.skills.map((id) => getSkill(id, scope));
  const workspace = workspaceOf(execution);
  const log = pending.worker.log;

  const controller = new AbortController();
  const reporter = new RunReporter(ctx.client, executionId, () => {
    appendFileSync(log, "── stop requested from the dashboard\n");
    controller.abort();
  });
  reporter.start();

  // The agent's timeout is an expectation here, not a ceiling. A node on a
  // laptop is doing real work in a real repository, and an implementer that
  // is twenty minutes past its hour is usually twenty minutes from done —
  // killing it throws away everything it built. So the log says it has run
  // past what its file expected, once, and the person decides: Stop on the
  // dashboard ends it, and nothing else does.
  const timeoutMs = prepared.agent.timeoutMs ?? 60 * 60_000;
  const overrun =
    timeoutMs > 0
      ? setTimeout(
          () =>
            appendFileSync(
              log,
              `── past the ${Math.round(timeoutMs / 60_000)} minutes its agent file expected, still running — ` +
                "not stopped; Stop on the dashboard ends it\n",
            ),
          Math.max(0, pending.startedAt + timeoutMs - Date.now()),
        )
      : null;
  overrun?.unref();

  let step: StepRecord;
  try {
    const res = await runClaudeCodeNode(
      prepared.agent,
      prepared.prompt,
      nodeId,
      {
        skills,
        workspace,
        spawnCli: ctx.spawnCli,
        signal: controller.signal,
        gatewayUrl: ctx.client.gatewayUrl,
        authToken: ctx.client.key,
        sessionId: `workflow:${executionId}`,
        // The person follows the node through this log, so what it says
        // and what it does both go there, as they would read in a terminal.
        onText: (text) => {
          const line = describeText(text);
          if (line) appendFileSync(log, line);
        },
        onToolCall: (call) => {
          appendFileSync(log, describeCall(call, workspace?.root ?? ""));
          reporter.event({
            type: "tool.called",
            executionId,
            at: Date.now(),
            nodeId,
            stepIndex: pending.stepIndex,
            tool: call.tool,
            ok: call.ok,
            summary: call.result.split("\n")[0].slice(0, 200),
            durationMs: call.durationMs,
          });
        },
      },
      null,
    );
    step = {
      nodeId,
      stepIndex: pending.stepIndex,
      visit: pending.visit,
      status: "completed",
      startedAt: pending.startedAt,
      finishedAt: Date.now(),
      input: prepared.inputs,
      output: res.output,
      usage: res.usage,
      toolCalls: res.toolCalls,
    };
  } catch (e) {
    const error = { code: e instanceof WorkflowError ? e.code : "MODEL_EXECUTION_ERROR", message: (e as Error).message };
    step = {
      nodeId,
      stepIndex: pending.stepIndex,
      visit: pending.visit,
      status: "failed",
      startedAt: pending.startedAt,
      finishedAt: Date.now(),
      input: prepared.inputs,
      output: null,
      error,
    };
  }

  if (overrun) clearTimeout(overrun);
  await reporter.stop();
  try {
    await record(ctx, executionId, step, false);
  } catch (e) {
    // A cancel that arrived on the very last report: the step is recorded
    // either way, and the session's next `gate next` settles the run.
    if (!(e instanceof WorkflowError && e.code === "RUN_CANCELLED")) throw e;
  }
  const seconds = Math.max(1, Math.round((step.finishedAt - step.startedAt) / 1000));
  appendFileSync(
    log,
    step.status === "completed" ? `── ✓ ${nodeId} (${seconds}s)\n` : `── ✗ ${nodeId}: ${step.error?.message} (${seconds}s)\n`,
  );
  // Cleared last: the marker is what tells `gate wait` the node is still going.
  clearPending(executionId);
  return step.status === "completed";
}

/** How long one `gate wait` follows the log before handing back to the session. */
const WAIT_SLICE_MS = 90_000;
const WAIT_POLL_MS = 2_000;

/**
 * Follows the worker: prints what the log has gained, and returns with the
 * next instruction once the node is over, or with `wait` again when this
 * slice of time is up — short enough for the session's shell call, long
 * enough that the person is not watching a prompt spin.
 */
export async function wait(ctx: SessionRunContext, executionId: string, forMs = WAIT_SLICE_MS): Promise<Instruction> {
  const until = Date.now() + forMs;
  for (;;) {
    const pending = readPending(executionId);
    // No marker means the worker finished and recorded its step (or nothing
    // was ever running); `next` works out what follows either way.
    if (!pending || !pending.worker) return next(ctx, executionId);

    const shown = pending.shown ?? 0;
    let text = "";
    try {
      text = readFileSync(pending.worker.log, "utf8");
    } catch {
      // A log not yet created is a worker that has not got going.
    }
    if (text.length > shown) {
      ctx.say(text.slice(shown).trimEnd());
      writePending({ ...pending, shown: text.length });
    }

    // A worker that has died leaves its marker; `next` turns that into a
    // failed step with the log to look at.
    if (!alive(pending.worker.pid)) return next(ctx, executionId);
    if (Date.now() >= until) {
      const scope = runScope(ctx.team, executionId);
      const { execution } = await ctx.client.execution(executionId);
      const workflow: WorkflowDefinition = getWorkflow(execution.workflowId, scope);
      const node = workflow.nodes.find((n) => n.id === pending.nodeId);
      const agent = node && node.type === "agent" ? getAgent(node.agent, scope) : { id: pending.nodeId, model: "?" };
      return waitInstruction(executionId, pending, agent);
    }
    await new Promise((r) => setTimeout(r, Math.min(WAIT_POLL_MS, Math.max(0, until - Date.now()))));
  }
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
): Promise<void> {
  if (execution.status !== "running") return;
  const workspace = workspaceOf(execution);
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
  await ctx.client
    .finish(executionId, { status, error, stepCount, workspace: summary, diff })
    .catch((e) => ctx.say(`could not report the run's outcome: ${(e as Error).message}`));

  if (status === "completed") {
    // Over for good: the pinned definitions and the logs have nothing left to
    // serve, and a worktree whose every commit is on the remote is a copy.
    // A failed run keeps all of it, because `gate continue` needs it.
    if (workspace) {
      const tidied = tidyRunWorkspace(workspace);
      if (tidied) ctx.say(tidied);
    }
    forgetRun(executionId);
  }
}

/**
 * Picks a failed run back up at the node it failed on, in the same worktree.
 *
 * The server drops the failed attempt from the history and marks the run as
 * running again; the next walk then lands on that node as if it had never
 * run, with everything before it kept — a failed reviewer is retried, not
 * the implementer that preceded it. Anything this machine still held for the
 * node — a worker's marker, a worker still alive — is cleared first, so the
 * retry starts clean.
 */
export async function continueRun(ctx: SessionRunContext, executionId: string): Promise<Instruction> {
  const { execution } = await ctx.client.execution(executionId);
  if (execution.driver !== "session") {
    throw new WorkflowError(
      "EXECUTION_NOT_RESUMABLE",
      "only a run /gate:run drove can be continued here; a run `gate run` drove starts over with `gate run`",
    );
  }
  if (execution.status === "running") return next(ctx, executionId);
  if (execution.status !== "failed") {
    throw new WorkflowError("EXECUTION_NOT_RESUMABLE", `this run ${execution.status}; there is nothing to continue`);
  }
  const workspace = workspaceOf(execution);
  if (workspace && !existsSync(workspace.root)) {
    throw new WorkflowError(
      "EXECUTION_NOT_RESUMABLE",
      `the worktree this run used (${workspace.root}) is gone; start the workflow again instead`,
    );
  }

  const pending = readPending(executionId);
  if (pending?.worker && alive(pending.worker.pid)) {
    try {
      process.kill(pending.worker.pid);
    } catch {
      // Already gone.
    }
  }
  clearPending(executionId);

  const reopened = await ctx.client.continueRun(executionId);
  if (!reopened.continued) {
    throw new WorkflowError("EXECUTION_NOT_RESUMABLE", reopened.reason ?? "this run cannot be continued");
  }
  ctx.say(
    reopened.retried?.length
      ? `▸ continuing ${executionId}: ${reopened.retried.join(", ")} will run again; everything before it stands`
      : `▸ continuing ${executionId}`,
  );
  return next(ctx, executionId);
}
