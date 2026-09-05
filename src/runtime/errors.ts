/** Typed failures the orchestrator can surface on a node, in the UI and in logs. */

export type WorkflowErrorCode =
  | "AGENT_DEFINITION_INVALID"
  | "AGENT_OUTPUT_TRUNCATED"
  | "AGENT_OUTPUT_VALIDATION_ERROR"
  | "COMMAND_EXECUTION_ERROR"
  | "LOOP_LIMIT_EXCEEDED"
  | "MODEL_EXECUTION_ERROR"
  | "RUN_CANCELLED"
  | "RUN_INPUT_MISSING"
  | "RUN_INTERRUPTED"
  | "NODE_TIMEOUT"
  | "TOOL_LIMIT_EXCEEDED"
  | "WORKFLOW_DEFINITION_INVALID"
  | "WORKFLOW_ROUTING_ERROR"
  | "WORKSPACE_ERROR";

export class WorkflowError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = code;
  }
}

export function errorCodeOf(e: unknown): WorkflowErrorCode | null {
  return e instanceof WorkflowError ? e.code : null;
}
