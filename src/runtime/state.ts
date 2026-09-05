import { WorkflowError } from "./errors";

/** The whole of a run's mutable state. Nodes only ever see what they declare. */

export interface NodeUsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** One tool invocation an agent made while working on a node. */
export interface ToolCallRecord {
  tool: string;
  input: unknown;
  ok: boolean;
  result: string;
  startedAt: number;
  durationMs: number;
}

export interface StepRecord {
  nodeId: string;
  stepIndex: number;
  visit: number;
  startedAt: number;
  finishedAt: number;
  status: "completed" | "failed";
  input: unknown;
  output: unknown;
  error?: { code: string; message: string };
  usage?: NodeUsageRecord;
  toolCalls?: ToolCallRecord[];
}

export interface WorkflowState {
  executionId: string;
  workflowId: string;
  status: "running" | "completed" | "failed";
  /** Caller-supplied run input, readable as `input.*`. */
  input: Record<string, unknown>;
  /** Validated output per node id, readable as `outputs.<nodeId>.*`. */
  outputs: Record<string, unknown>;
  visitCounts: Record<string, number>;
  stepCount: number;
  history: StepRecord[];
  error: { code: string; message: string } | null;
}

/** Carries a resumed run's progress into a fresh state instead of starting empty. */
export interface ResumeSeed {
  outputs: Record<string, unknown>;
  visitCounts: Record<string, number>;
  stepCount: number;
  history: StepRecord[];
}

export function createState(
  executionId: string,
  workflowId: string,
  input: Record<string, unknown> = {},
  seed?: ResumeSeed,
): WorkflowState {
  return {
    executionId,
    workflowId,
    status: "running",
    input,
    outputs: seed?.outputs ?? {},
    visitCounts: seed?.visitCounts ?? {},
    stepCount: seed?.stepCount ?? 0,
    history: seed?.history ?? [],
    error: null,
  };
}

/** Context for condition evaluation: the two roots a workflow may read. */
export function conditionContext(
  state: Pick<WorkflowState, "outputs" | "input">,
): { outputs: Record<string, unknown>; input: Record<string, unknown> } {
  return { outputs: state.outputs, input: state.input };
}

function readPath(root: unknown, segments: string[]): unknown {
  let cur = root;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Resolve a node's declared input paths into the nested object its prompt
 * renders against. Only declared paths are materialized — the full state is
 * never handed to an agent.
 *
 * A trailing "?" marks the path optional: it resolves to an empty string when
 * the value does not exist yet. That is what makes feedback loops expressible
 * — an implementation node can read the tester's failures on a retry without
 * failing on its first visit, before the tester has ever run.
 */
export function resolveInputs(paths: string[], state: WorkflowState, nodeId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of paths) {
    const optional = raw.endsWith("?");
    const path = optional ? raw.slice(0, -1) : raw;
    const segments = path.split(".").filter(Boolean);
    if (!segments.length) continue;
    const fromRunInput = segments[0] === "input";
    const found = fromRunInput ? readPath(state.input, segments.slice(1)) : readPath(state.outputs, segments);
    if (found === undefined && !optional) {
      throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `node "${nodeId}" requires input "${path}", which has not been produced yet`, {
        nodeId,
        path,
      });
    }
    const value = found === undefined ? "" : found;
    let cursor = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i];
      if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]] = value;
  }
  return out;
}
