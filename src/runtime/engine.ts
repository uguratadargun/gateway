import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { getAgent } from "@/agents/registry";
import { renderTemplate, TemplateError } from "@/agents/template";
import type { AgentDefinition } from "@/agents/types";
import type { EventSink, WorkflowEvent } from "@/events/types";
import type { MemoryAccess } from "@/memory/cards";
import type { ModelProvider } from "@/providers/types";
import { costForUsage, tierOf } from "@/lib/pricing";
import type { SkillDefinition } from "@/skills/types";
import { findNode, skipTargetOf, type WorkflowDefinition, type WorkflowNode } from "@/workflows/types";

import { WorkflowError, type WorkflowErrorCode } from "./errors";
import { executeAgentNode } from "./executors/agent";
import { runCommand, type CommandRunner } from "./executors/command";
import { selectEdge } from "./executors/condition";
import { conditionContext, createState, type NodeUsageRecord, type ResumeSeed, type StepRecord, type ToolCallRecord, type WorkflowState } from "./state";
import type { RunWorkspace } from "./workspace";

/**
 * The deterministic control plane. Given a workflow and a state, the engine —
 * not a model — decides what runs next: node executors produce outputs, edge
 * guards choose the path, and loop protection bounds the whole thing.
 *
 * A run walks the graph from the entry node; a `parallel` node walks each of
 * its branches at the same time and resumes at the join node once they have all
 * finished. Branches are validated at load time to be disjoint regions, so
 * concurrency never means two nodes racing for the same output.
 */

/**
 * There are no ceilings a workflow file cannot raise. A pipeline that loops a
 * node until a test suite passes, on a task that takes hours, is a legitimate
 * run and not a bad definition — and a hard 500/50 cut it off with everything
 * it had spent already gone. A workflow that wants a cap declares one
 * (`maxWorkflowSteps` / `maxVisits`, 0 meaning none); a run that turns out to
 * be looping is stopped from the dashboard, where it can be seen looping.
 */

export interface RunWorkflowOptions {
  provider: ModelProvider;
  input?: Record<string, unknown>;
  executionId?: string;
  emit?: EventSink;
  /** Injectable for tests; defaults to the file-backed agent registry. */
  loadAgent?: (id: string) => AgentDefinition;
  /** The skill library an agent's declared skills resolve in. Same reason. */
  loadSkill?: (id: string) => SkillDefinition;
  runCommand?: CommandRunner;
  /** The run's git worktree. Without one, agents get no tools. */
  workspace?: RunWorkspace | null;
  /** How many tool rounds one agent may take before its node fails. */
  maxToolIterations?: number;
  /** Passed through to agents that run as a spawned Claude Code. */
  claudeCode?: { gatewayUrl?: string; authToken?: string };
  /** The team's memory, for agents that declare the memory tools. */
  memory?: MemoryAccess;
  /** Called as each step lands in history, so a run can be persisted live. */
  onStep?: (step: StepRecord) => void;
  /**
   * Continues a stopped run instead of starting from the entry node: the
   * caller has already worked out where it stopped and reconstructed its
   * progress (src/executions/resume.ts does this from history). Ceilings stay
   * cumulative — seeded visitCounts/stepCount are not reset — so resuming a
   * run that hit maxVisits or maxWorkflowSteps re-enters at the same node and
   * halts again immediately, at no cost, rather than bypassing the limit.
   */
  resume?: ResumeSeed & { startNodeId: string };
  /** Cancels the run. Checked before every node and inside an agent's tool
   *  loop, so a stop takes effect without waiting out the current step. */
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * What kept sending a node round again.
 *
 * A loop limit on its own says a node repeated, not why — and "why" is almost
 * always the same gate refusing it. The last step before this one is the one
 * that routed here, so naming it, and the signal it refused on, turns "ran 6
 * times" into something you can act on without reading the whole history.
 */
function sentBack(state: WorkflowState, nodeId: string): string {
  const previous = [...state.history].reverse().find((h) => h.nodeId !== nodeId);
  if (!previous) return "";
  const output = previous.output;
  let signal = "";
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (o.ok === false) signal = typeof o.exitCode === "number" ? ` (exit ${o.exitCode})` : " (failed)";
    else if (typeof o.verdict === "string" && o.verdict !== "approved") signal = ` (${o.verdict})`;
    else if (o.passed === false) signal = " (tests failed)";
  }
  return `; last sent back by "${previous.nodeId}"${signal}`;
}

/**
 * What one step cost, in API-list-equivalent USD — the same measure the
 * executions page reports, so a budget is denominated in the number the user
 * already sees. Command and condition nodes record no usage and cost nothing.
 */
function costOfStep(usage: NodeUsageRecord | undefined): number {
  if (!usage) return 0;
  return costForUsage(
    tierOf(usage.model),
    { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens },
    { model: usage.model },
  );
}

/**
 * A command node's argv, with `{{outputs.x.y}}` and `{{input.k}}` filled in.
 *
 * Rendered per argument, never re-split: an argument is one argument whatever
 * the value turns out to contain, so a commit message with spaces and newlines
 * stays a single argv entry and no shell quoting is involved anywhere.
 */
function renderCommand(command: string[], ctx: Record<string, unknown>, nodeId: string): string[] {
  return command.map((arg) => {
    if (!arg.includes("{{")) return arg;
    try {
      return renderTemplate(arg, ctx);
    } catch (e) {
      throw new WorkflowError(
        "WORKFLOW_ROUTING_ERROR",
        `node "${nodeId}": ${e instanceof TemplateError ? e.message : String(e)}`,
        { nodeId },
      );
    }
  });
}

export async function runWorkflow(workflow: WorkflowDefinition, opts: RunWorkflowOptions): Promise<WorkflowState> {
  const now = opts.now ?? Date.now;
  const emit = (e: WorkflowEvent) => opts.emit?.(e);
  const executionId = opts.executionId ?? randomUUID();
  const state = createState(executionId, workflow.id, opts.input ?? {}, opts.resume);
  const startNodeId = opts.resume?.startNodeId ?? workflow.entry;
  const loadAgent = opts.loadAgent ?? getAgent;
  const loadSkill = opts.loadSkill;
  const execCommand = opts.runCommand ?? runCommand;
  const maxSteps = workflow.maxWorkflowSteps;
  const maxVisits = workflow.maxVisits;
  const maxCost = workflow.maxCostUsd;
  /**
   * What this run has spent, seeded from the history a resume carries so the
   * budget is cumulative across a lineage rather than refilled by continuing.
   * Command and condition nodes record no usage and cost nothing.
   */
  let spentUsd = state.history.reduce((sum, step) => sum + costOfStep(step.usage), 0);

  /** Ends the run. The first failure wins; later branches see it and unwind. */
  function halt(code: WorkflowErrorCode, message: string, nodeId?: string): void {
    if (state.status !== "running") return;
    state.status = "failed";
    state.error = { code, message };
    emit({ type: "workflow.failed", executionId, at: now(), code, message, nodeId });
  }

  /**
   * Walks the graph from `startId` until the run ends or `stopAt` is reached.
   * Branch tasks call it recursively with the join node as `stopAt`.
   */
  async function runFrom(startId: string, stopAt: string | null): Promise<void> {
    let currentId = startId;
    for (;;) {
      // A terminal node or a failing sibling branch ends every walk in flight.
      if (state.status !== "running") return;
      // A cancelled run stops here rather than at the next node boundary it
      // happens to reach; branches in flight see the halt and unwind too.
      if (opts.signal?.aborted) return halt("RUN_CANCELLED", "run cancelled", currentId);
      if (currentId === stopAt) return;

      const node = findNode(workflow, currentId);
      if (!node) return halt("WORKFLOW_ROUTING_ERROR", `node "${currentId}" does not exist`, currentId);

      // A node switched off in the workflow file is not run at all: no model
      // call, no command, no output, no step, nothing spent, and no visit
      // recorded — `visits.x` counts what ran, and this did not. The run
      // leaves along one of the node's own edges, so a step turned off changes
      // what a run does without changing where its graph goes.
      const skipTo = skipTargetOf(node);
      if (skipTo) {
        emit({ type: "edge.selected", executionId, at: now(), from: node.id, to: skipTo, label: "off" });
        currentId = skipTo;
        continue;
      }

      if (node.type === "terminal") {
        state.status = node.status;
        emit({ type: "workflow.completed", executionId, at: now(), status: node.status, terminalNodeId: node.id });
        return;
      }

      const visit = (state.visitCounts[node.id] = (state.visitCounts[node.id] ?? 0) + 1);
      state.stepCount += 1;
      if (maxVisits > 0 && visit > maxVisits) {
        return halt(
          "LOOP_LIMIT_EXCEEDED",
          `node "${node.id}" ran ${visit} times (max ${maxVisits})${sentBack(state, node.id)}`,
          node.id,
        );
      }
      if (maxSteps > 0 && state.stepCount > maxSteps) {
        return halt("LOOP_LIMIT_EXCEEDED", `workflow exceeded ${maxSteps} steps`, node.id);
      }

      const stepIndex = state.stepCount - 1;
      const startedAt = now();
      emit({ type: "node.started", executionId, at: startedAt, nodeId: node.id, stepIndex, visit });

      // The worktree can go away under a run — removed by hand, or by a
      // cleanup that did not check for live runs. Without this the run carries
      // on until some child process happens to need the directory, and then
      // dies saying only that it produced no output.
      if (opts.workspace && !existsSync(opts.workspace.root)) {
        return halt(
          "WORKSPACE_ERROR",
          `this run's worktree is gone (${opts.workspace.root}); it was removed while the run was going`,
          node.id,
        );
      }

      let input: unknown = null;
      let output: unknown = null;
      let usage: NodeUsageRecord | undefined;
      let toolCalls: ToolCallRecord[] | undefined;
      try {
        if (node.type === "agent") {
          const res = await executeAgentNode(node, state, {
            provider: opts.provider,
            loadAgent,
            loadSkill,
            workspace: opts.workspace ?? null,
            maxToolIterations: opts.maxToolIterations,
            claudeCode: opts.claudeCode,
            memory: opts.memory,
            signal: opts.signal,
            onToolCall: (call) =>
              emit({
                type: "tool.called",
                executionId,
                at: now(),
                nodeId: node.id,
                stepIndex,
                tool: call.tool,
                ok: call.ok,
                summary: call.result.split("\n")[0].slice(0, 200),
                durationMs: call.durationMs,
              }),
          });
          input = res.input;
          output = res.output;
          usage = res.usage;
          toolCalls = res.toolCalls.length ? res.toolCalls : undefined;
        } else if (node.type === "command") {
          // Rendered here, where the state is: a command that has to carry what
          // a node produced — a commit message, a branch, a review verdict —
          // could otherwise only be written as a constant, which is why every
          // pipeline that needed one reached for an agent to run `git` instead.
          // `outputs` and `input` are the same two roots a condition reads.
          const command = renderCommand(node.command, conditionContext(state), node.id);
          input = command;
          output = await execCommand({ ...node, command }, { defaultCwd: opts.workspace?.root, signal: opts.signal });
        } else if (node.type === "parallel") {
          input = { branches: node.branches, join: node.join };
          for (const branch of node.branches) {
            emit({ type: "edge.selected", executionId, at: now(), from: node.id, to: branch, label: "parallel" });
          }
          // allSettled, not all: every branch is given the chance to unwind
          // before the run is closed out, so history stays complete.
          const settled = await Promise.allSettled(node.branches.map((branch) => runFrom(branch, node.join)));
          const crashed = settled.find((r) => r.status === "rejected");
          if (crashed?.status === "rejected") throw crashed.reason;
          if (state.status !== "running") return;
        }
      } catch (e) {
        const code = e instanceof WorkflowError ? e.code : "MODEL_EXECUTION_ERROR";
        const message = (e as Error).message;
        const finishedAt = now();
        // An agent node that fails partway through has already made real tool
        // calls and spent real tokens; the executor attaches both to the
        // error it throws, so a failure is recorded with the evidence instead
        // of looking like nothing happened.
        const progress = e instanceof WorkflowError ? e.detail : undefined;
        const step: StepRecord = {
          nodeId: node.id,
          stepIndex,
          visit,
          startedAt,
          finishedAt,
          status: "failed",
          input,
          output: null,
          error: { code, message },
          toolCalls: (progress?.toolCalls as ToolCallRecord[] | undefined) ?? toolCalls,
          usage: progress?.usage as NodeUsageRecord | undefined,
        };
        state.history.push(step);
        opts.onStep?.(step);
        spentUsd += costOfStep(step.usage);
        emit({ type: "node.failed", executionId, at: finishedAt, nodeId: node.id, stepIndex, code, message });
        return halt(code, message, node.id);
      }

      // Control nodes route; they do not contribute state an agent can read.
      if (node.type !== "condition" && node.type !== "parallel") state.outputs[node.id] = output;
      const finishedAt = now();
      const step: StepRecord = {
        nodeId: node.id,
        stepIndex,
        visit,
        startedAt,
        finishedAt,
        status: "completed",
        input,
        output,
        usage,
        toolCalls,
      };
      state.history.push(step);
      opts.onStep?.(step);
      emit({ type: "node.output", executionId, at: finishedAt, nodeId: node.id, stepIndex, output });
      emit({
        type: "node.completed",
        executionId,
        at: finishedAt,
        nodeId: node.id,
        stepIndex,
        durationMs: finishedAt - startedAt,
        usage,
      });

      // Checked between nodes, never mid-node: a node that is already running
      // has been paid for, and killing it half-way buys nothing back.
      spentUsd += costOfStep(usage);
      if (maxCost > 0 && spentUsd > maxCost) {
        return halt(
          "BUDGET_EXCEEDED",
          `run spent $${spentUsd.toFixed(2)}, over this workflow's $${maxCost.toFixed(2)} budget`,
          node.id,
        );
      }

      if (node.type === "parallel") {
        emit({ type: "edge.selected", executionId, at: now(), from: node.id, to: node.join, label: "join" });
        currentId = node.join;
        continue;
      }

      let edge;
      try {
        edge = selectEdge(node as WorkflowNode, state);
      } catch (e) {
        const code = e instanceof WorkflowError ? e.code : "WORKFLOW_ROUTING_ERROR";
        return halt(code, (e as Error).message, node.id);
      }
      emit({ type: "edge.selected", executionId, at: now(), from: node.id, to: edge.to, label: edge.label });
      currentId = edge.to;
    }
  }

  emit({ type: "workflow.started", executionId, at: now(), workflowId: workflow.id, entry: startNodeId });
  await runFrom(startNodeId, null);
  return state;
}
