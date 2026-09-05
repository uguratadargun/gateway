import { z } from "zod";

import type { ConditionNode } from "./condition";

/**
 * Workflow definitions: a declarative graph of nodes and edges. The engine —
 * never a model — decides which node runs next, so everything routing-related
 * is data in this file.
 */

const nodeId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes");

const edgeSchema = z
  .object({
    /** Condition expression; an edge without one is the fallback. */
    when: z.string().min(1).max(500).optional(),
    to: nodeId,
    label: z.string().max(64).optional(),
  })
  .strict();

const baseNode = {
  id: nodeId,
  label: z.string().max(80).optional(),
  edges: z.array(edgeSchema).max(20).optional(),
  /** Sugar for a single unconditional edge. */
  next: nodeId.optional(),
};

export const workflowNodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...baseNode,
      type: z.literal("agent"),
      agent: z.string().min(1).max(64),
      /** Dotted paths this node may read. Defaults to the agent's own declaration. */
      inputs: z.array(z.string().min(1).max(200)).max(50).optional(),
    })
    .strict(),
  z
    .object({
      ...baseNode,
      type: z.literal("command"),
      /** argv, never a shell string: the runtime spawns it without a shell. */
      command: z.array(z.string().min(1)).min(1).max(50),
      cwd: z.string().max(500).optional(),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    })
    .strict(),
  z.object({ ...baseNode, type: z.literal("condition") }).strict(),
  z
    .object({
      id: nodeId,
      label: z.string().max(80).optional(),
      type: z.literal("parallel"),
      /** Branch entry nodes, started together. Each branch must reach `join`. */
      branches: z.array(nodeId).min(2).max(10),
      /** Where the branches meet; the run continues here once all have finished. */
      join: nodeId,
    })
    .strict(),
  z
    .object({
      id: nodeId,
      label: z.string().max(80).optional(),
      type: z.literal("terminal"),
      status: z.enum(["completed", "failed"]).default("completed"),
    })
    .strict(),
]);

/**
 * A repository the run may work in. The engine never touches it directly: each
 * run gets its own git worktree on its own branch, and that is what the agents'
 * tools and the command nodes see.
 */
const workspaceSchema = z
  .object({
    /** Pins the pipeline to one repository; omitted, it is a per-run input. */
    repo: z.string().min(1).max(500).optional(),
    /** What the run branches from (default HEAD). */
    baseRef: z.string().min(1).max(200).optional(),
    branchPrefix: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9._/-]+$/, "use letters, digits, dots, slashes and dashes")
      .optional(),
  })
  .strict();

export type WorkspaceSpec = z.infer<typeof workspaceSchema>;

export const workflowDefinitionSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    entry: nodeId,
    /** Declared to give agents file/command tools and to run commands in a worktree. */
    workspace: workspaceSchema.optional(),
    /** Hard stop for the whole run; the engine caps this regardless. */
    maxWorkflowSteps: z.number().int().min(1).max(500).default(50),
    /** Hard stop for revisits of any single node (loop protection). */
    maxVisits: z.number().int().min(1).max(50).default(5),
    nodes: z.array(workflowNodeSchema).min(1).max(100),
  })
  .strict();

export type WorkflowNodeInput = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof edgeSchema> & { condition: ConditionNode | null };

/** Distributes over the union so `node.type` still narrows after the swap. */
type WithResolvedEdges<T> = T extends unknown ? Omit<T, "edges"> & { edges: WorkflowEdge[] } : never;
export type WorkflowNode = WithResolvedEdges<WorkflowNodeInput>;

export interface WorkflowDefinition extends Omit<z.infer<typeof workflowDefinitionSchema>, "nodes"> {
  id: string;
  nodes: WorkflowNode[];
  sourcePath: string;
  updatedAt: number;
}

export function findNode(wf: WorkflowDefinition, id: string): WorkflowNode | undefined {
  return wf.nodes.find((n) => n.id === id);
}

/**
 * Where a node can hand control next. A `parallel` node routes through its
 * branches and its join rather than through edges, so graph walks (validation,
 * reachability, layout) have to ask here rather than read `edges` directly.
 */
export function successorsOf(node: WorkflowNode): string[] {
  if (node.type === "parallel") return [...node.branches, node.join];
  return node.edges.map((e) => e.to);
}
