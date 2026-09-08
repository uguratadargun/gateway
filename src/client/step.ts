import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { getAgent } from "@/agents/registry";
import type { ExecutionStepRecord } from "@/executions/types";
import { parseOutput, prepareAgentNode } from "@/runtime/executors/agent";
import { runCommand } from "@/runtime/executors/command";
import { WorkflowError } from "@/runtime/errors";
import type { StepRecord, WorkflowState } from "@/runtime/state";
import { renderTemplate } from "@/agents/template";
import { conditionContext } from "@/runtime/state";
import { createRunWorkspace, readRunDiff, summarizeWorkspace, type RunWorkspace } from "@/runtime/workspace";
import { getSkill, resolveSkillDir } from "@/skills/registry";
import { getWorkflow } from "@/workflows/registry";
import type { WorkflowDefinition } from "@/workflows/types";

import type { GateClient } from "./api";
import { CLI_VERSION } from "./api";
import { cacheScope } from "./cache";
import { gateHome } from "./config";
import { resolveRepo } from "./run";
import { nextInSession } from "./walk";

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
 * this runs them itself and moves on. Only agent nodes need a model.
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
  | { do: "done"; executionId: string; status: "completed" | "failed"; branch: string | null; workspace: string | null }
  | { do: "failed"; executionId: string; nodeId: string; error: { code: string; message: string } };

/** Which node was handed out, so `gate step` can refuse an answer to another one. */
interface Pending {
  executionId: string;
  nodeId: string;
  stepIndex: number;
  visit: number;
  startedAt: number;
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

/** The run's workspace, as it was recorded when the run began. */
function workspaceOf(execution: { workspace: RunWorkspace | null }): RunWorkspace | null {
  return execution.workspace ?? null;
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
): Promise<Instruction> {
  const scope = cacheScope(ctx.team);
  const workflow = getWorkflow(workflowId, scope);

  const runInput = { ...input };
  let repo: string | null = null;
  if (workflow.workspace) {
    repo = resolveRepo(workflow, runInput, cwd, repos);
    runInput.repo = repo;
  }

  const executionId = await ctx.client.startRun({
    workflowId: workflow.id,
    input: runInput,
    client: { host: hostname(), repo: repo ?? undefined, version: CLI_VERSION },
    driver: "session",
  });

  if (workflow.workspace) {
    try {
      const workspace = createRunWorkspace({ ...workflow.workspace, repo: repo! }, executionId);
      ctx.say(`worktree ${workspace.root} on branch ${workspace.branch}`);
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
    const scope = cacheScope(ctx.team);
    const workflow: WorkflowDefinition = getWorkflow(execution.workflowId, scope);
    const position = nextInSession(workflow, steps as ExecutionStepRecord[], execution.input);

    if (position.kind === "failed") {
      clearPending(executionId);
      await settle(ctx, executionId, execution, steps.length, "failed", position.error);
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
      const startedAt = Date.now();
      writePending({
        executionId,
        nodeId: node.id,
        stepIndex: position.stepIndex,
        visit: position.visit,
        startedAt,
      });
      const workspace = workspaceOf(execution);

      // Said now, not when the answer comes back. A node a session works on
      // takes as long as the work takes, and until this the run looked idle:
      // the dashboard lit the node up only once it was already over, and the
      // terminal said nothing at all about whose turn it was.
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
          ],
          steps: [],
        })
        .catch(() => {});
      ctx.say(
        `▸ ${node.id} · agent ${prepared.agent.id} (${prepared.agent.model}` +
          `${prepared.agent.effort ? `/${prepared.agent.effort}` : ""})` +
          `${position.visit > 1 ? ` · pass ${position.visit}` : ""}`,
      );
      if (workspace) ctx.say(`  in ${workspace.root}`);
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

      const shape =
        prepared.agent.output.type === "json"
          ? `a JSON object with exactly these keys: ${Object.entries(prepared.agent.output.schema)
              .map(([k, t]) => `${k} (${t})`)
              .join(", ")}`
          : "the answer as plain text";
      return {
        do: "agent",
        executionId,
        nodeId: node.id,
        agent: prepared.agent.id,
        prompt: prepared.prompt,
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
          "Ask the user when the brief does not settle something, or something looks wrong. They can answer.",
          `When the work is done, write ${shape} to a file and hand it back:`,
          `  gate step ${executionId} ${node.id} --output-file <file>`,
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
  const scope = cacheScope(ctx.team);
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
    },
    false,
  );
  ctx.say(`✓ ${nodeId} (${Math.max(1, Math.round((finishedAt - pending.startedAt) / 1000))}s)`);
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
): Promise<void> {
  const res = await ctx.client.report(executionId, {
    events: [
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
}
