import { randomUUID } from "node:crypto";

import { getAgent } from "@/agents/registry";
import type { AgentDefinition } from "@/agents/types";
import type { EventSink, WorkflowEvent } from "@/events/types";
import type { ModelProvider } from "@/providers/types";
import { findNode, type WorkflowDefinition, type WorkflowNode } from "@/workflows/types";

import { WorkflowError, type WorkflowErrorCode } from "./errors";
import { executeAgentNode } from "./executors/agent";
import { runCommand, type CommandRunner } from "./executors/command";
import { selectEdge } from "./executors/condition";
import { createState, type NodeUsageRecord, type StepRecord, type ToolCallRecord, type WorkflowState } from "./state";
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

/** Ceilings a workflow file cannot raise, so a bad definition can't hang gate. */
const HARD_MAX_STEPS = 500;
const HARD_MAX_VISITS = 50;

export interface RunWorkflowOptions {
  provider: ModelProvider;
  input?: Record<string, unknown>;
  executionId?: string;
  emit?: EventSink;
  /** Injectable for tests; defaults to the file-backed agent registry. */
  loadAgent?: (id: string) => AgentDefinition;
  runCommand?: CommandRunner;
  /** The run's git worktree. Without one, agents get no tools. */
  workspace?: RunWorkspace | null;
  /** How many tool rounds one agent may take before its node fails. */
  maxToolIterations?: number;
  /** Called as each step lands in history, so a run can be persisted live. */
  onStep?: (step: StepRecord) => void;
  now?: () => number;
}

export async function runWorkflow(workflow: WorkflowDefinition, opts: RunWorkflowOptions): Promise<WorkflowState> {
  const now = opts.now ?? Date.now;
  const emit = (e: WorkflowEvent) => opts.emit?.(e);
  const executionId = opts.executionId ?? randomUUID();
  const state = createState(executionId, workflow.id, opts.input ?? {});
  const loadAgent = opts.loadAgent ?? getAgent;
  const execCommand = opts.runCommand ?? runCommand;
  const maxSteps = Math.min(workflow.maxWorkflowSteps, HARD_MAX_STEPS);
  const maxVisits = Math.min(workflow.maxVisits, HARD_MAX_VISITS);

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
      if (currentId === stopAt) return;

      const node = findNode(workflow, currentId);
      if (!node) return halt("WORKFLOW_ROUTING_ERROR", `node "${currentId}" does not exist`, currentId);

      if (node.type === "terminal") {
        state.status = node.status;
        emit({ type: "workflow.completed", executionId, at: now(), status: node.status, terminalNodeId: node.id });
        return;
      }

      const visit = (state.visitCounts[node.id] = (state.visitCounts[node.id] ?? 0) + 1);
      state.stepCount += 1;
      if (visit > maxVisits) {
        return halt("LOOP_LIMIT_EXCEEDED", `node "${node.id}" ran ${visit} times (max ${maxVisits})`, node.id);
      }
      if (state.stepCount > maxSteps) {
        return halt("LOOP_LIMIT_EXCEEDED", `workflow exceeded ${maxSteps} steps`, node.id);
      }

      const stepIndex = state.stepCount - 1;
      const startedAt = now();
      emit({ type: "node.started", executionId, at: startedAt, nodeId: node.id, stepIndex, visit });

      let input: unknown = null;
      let output: unknown = null;
      let usage: NodeUsageRecord | undefined;
      let toolCalls: ToolCallRecord[] | undefined;
      try {
        if (node.type === "agent") {
          const res = await executeAgentNode(node, state, {
            provider: opts.provider,
            loadAgent,
            workspace: opts.workspace ?? null,
            maxToolIterations: opts.maxToolIterations,
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
          input = node.command;
          output = await execCommand(node, { defaultCwd: opts.workspace?.root });
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
          toolCalls,
        };
        state.history.push(step);
        opts.onStep?.(step);
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

  emit({ type: "workflow.started", executionId, at: now(), workflowId: workflow.id, entry: workflow.entry });
  await runFrom(workflow.entry, null);
  return state;
}
