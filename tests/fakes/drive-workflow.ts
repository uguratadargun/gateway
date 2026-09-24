import { getAgent } from "@/agents/registry";
import { renderTemplate } from "@/agents/template";
import type { AgentDefinition } from "@/agents/types";
import { nextInSession } from "@/client/walk";
import type { EventSink } from "@/events/types";
import type { ExecutionStepRecord } from "@/executions/types";
import type { ModelProvider } from "@/providers/types";
import { WorkflowError, type WorkflowErrorCode } from "@/runtime/errors";
import { parseOutput, prepareAgentNode } from "@/runtime/executors/agent";
import { runCommand as realRunCommand, type CommandRunner } from "@/runtime/executors/command";
import { conditionContext, createState, type StepRecord, type WorkflowState } from "@/runtime/state";
import type { WorkflowDefinition } from "@/workflows/types";

/**
 * A whole run of a workflow, the way a session drives one, with a scripted
 * model standing in for the person's Claude Code.
 *
 * Every step goes through the code a real run uses: `nextInSession` decides
 * where the run is from the steps so far — the same walk and the same edge
 * selection `gate next` uses — `prepareAgentNode` renders the agent's prompt,
 * and `parseOutput` checks the answer against what the agent declared. The
 * only stand-ins are the answers themselves (`provider`, asked once per agent
 * node with the rendered prompt) and the commands (`runCommand`). What comes
 * back is the run as a state: its status, its outputs, how often each node
 * ran, and the events a watcher would have seen.
 */
export async function driveWorkflow(
  workflow: WorkflowDefinition,
  opts: {
    provider: ModelProvider;
    input?: Record<string, unknown>;
    runCommand?: CommandRunner;
    loadAgent?: (id: string) => AgentDefinition;
    emit?: EventSink;
  },
): Promise<WorkflowState> {
  const executionId = "drive";
  const state = createState(executionId, workflow.id, opts.input ?? {});
  const steps: ExecutionStepRecord[] = [];
  const loadAgent = opts.loadAgent ?? ((id: string) => getAgent(id));
  const execCommand = opts.runCommand ?? realRunCommand;
  const emit = opts.emit ?? (() => {});
  emit({ type: "workflow.started", executionId, at: Date.now(), workflowId: workflow.id, entry: workflow.entry });

  for (;;) {
    const position = nextInSession(workflow, steps, state.input);
    if (position.kind === "failed") {
      state.status = "failed";
      state.error = position.error;
      emit({ type: "workflow.failed", executionId, at: Date.now(), code: position.error.code as WorkflowErrorCode, message: position.error.message, nodeId: position.nodeId });
      return state;
    }
    if (position.kind === "done") {
      state.status = position.status;
      emit({ type: "workflow.completed", executionId, at: Date.now(), status: position.status, terminalNodeId: position.terminalNodeId });
      return state;
    }

    const { node, visit, stepIndex } = position;
    state.visitCounts[node.id] = visit;
    state.stepCount = stepIndex + 1;
    const view: WorkflowState = { ...state, outputs: position.outputs };
    emit({ type: "node.started", executionId, at: Date.now(), nodeId: node.id, stepIndex, visit });

    let input: unknown = null;
    let output: unknown = null;
    let error: { code: string; message: string } | undefined;
    try {
      if (node.type === "agent") {
        const prepared = prepareAgentNode(node, view, loadAgent);
        input = prepared.inputs;
        const answer = await opts.provider.execute({
          model: prepared.agent.model,
          messages: [{ role: "user", content: prepared.prompt }],
          context: { executionId, nodeId: node.id, workflowId: workflow.id },
        });
        output = parseOutput(prepared.agent, answer.text, node.id);
      } else if (node.type === "command") {
        const command = node.command.map((arg) => (arg.includes("{{") ? renderTemplate(arg, conditionContext(view)) : arg));
        input = command;
        output = await execCommand({ ...node, command });
      } else if (node.type === "parallel") {
        input = { branches: node.branches, join: node.join };
      }
    } catch (e) {
      error = { code: e instanceof WorkflowError ? e.code : "MODEL_EXECUTION_ERROR", message: (e as Error).message };
    }

    const step: StepRecord = {
      nodeId: node.id,
      stepIndex,
      visit,
      status: error ? "failed" : "completed",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      input,
      output: error ? null : output,
      ...(error ? { error } : {}),
    };
    state.history.push(step);
    steps.push({ ...step, executionId } as unknown as ExecutionStepRecord);
    if (!error && node.type !== "condition" && node.type !== "parallel") state.outputs[node.id] = output;
    emit(
      error
        ? { type: "node.failed", executionId, at: Date.now(), nodeId: node.id, stepIndex, code: error.code as WorkflowErrorCode, message: error.message }
        : { type: "node.completed", executionId, at: Date.now(), nodeId: node.id, stepIndex, durationMs: 0 },
    );
  }
}
