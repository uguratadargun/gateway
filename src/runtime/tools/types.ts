/**
 * Agent tools: the boundary between reasoning and side effects. An agent can
 * only ever use the tools its Markdown file declares, and every tool here is
 * confined to the run's workspace — the engine hands one in, the tool cannot
 * reach outside it.
 */

export interface ToolContext {
  /** Absolute path the run may touch. Nothing outside it is reachable. */
  root: string;
  nodeId: string;
  executionId: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema, sent to the model as the tool's input shape. */
  inputSchema: Record<string, unknown>;
  /** Tools that change something, for the UI and for read-only agents. */
  mutates: boolean;
  /** Returns the text handed back to the model as the tool result. */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolError extends Error {}
