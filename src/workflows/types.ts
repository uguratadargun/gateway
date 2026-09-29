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

/**
 * Switching a step off without taking it out of the graph.
 *
 * A `disabled` node is not run at all — no model call, no command, no output,
 * no step, nothing spent — and the run carries straight on at `skipTo`, which
 * must be one of the node's own edges: turning a step off changes what a run
 * does, never where the graph can go. A node with a single edge needs no
 * `skipTo`; one with several has to say which way a run leaves it, because the
 * edge that would have decided reads an output nothing produced.
 *
 * Only the nodes that do work can be switched off. `condition` and `parallel`
 * are routing, and a routing node that routes nowhere is a broken graph, not a
 * paused one; `terminal` is the end of the run.
 */
const skippable = {
  disabled: z.boolean().optional(),
  /** Which edge a run takes past this node while it is off. */
  skipTo: nodeId.optional(),
};

export const workflowNodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...baseNode,
      ...skippable,
      type: z.literal("agent"),
      agent: z.string().min(1).max(64),
      /** Dotted paths this node may read. Defaults to the agent's own declaration. */
      inputs: z.array(z.string().min(1).max(200)).max(50).optional(),
    })
    .strict(),
  z
    .object({
      ...baseNode,
      ...skippable,
      type: z.literal("command"),
      /** argv, never a shell string: the runtime spawns it without a shell. */
      command: z.array(z.string().min(1)).min(1).max(50),
      cwd: z.string().max(500).optional(),
      /** Unset = one hour, the same default an agent node gets; 0 = no timeout. */
      timeoutMs: z.number().int().min(0).optional(),
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
    /**
     * The three ceilings gate's own engine once enforced. Accepted, so every
     * workflow file written with them keeps loading, and read by nothing: a run
     * a session drives has no ceiling, and a loop ends on its own give-up edge.
     */
    maxWorkflowSteps: z.number().int().min(0).default(0),
    maxVisits: z.number().int().min(0).default(0),
    maxCostUsd: z.number().min(0).default(0),
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
 * Where a run continues instead of running this node, or null when the node is
 * not switched off. Validated at load time, so a `disabled` node always has
 * one: the engine, the session walk and the editor all ask here rather than
 * each deciding for themselves what "off" routes to.
 */
export function skipTargetOf(node: WorkflowNode): string | null {
  if (node.type !== "agent" && node.type !== "command") return null;
  if (!node.disabled) return null;
  if (node.skipTo) return node.skipTo;
  return node.edges.length === 1 ? node.edges[0].to : null;
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
