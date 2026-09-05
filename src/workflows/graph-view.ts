import type { WorkflowLayout } from "@/executions/types";

/**
 * Turning a workflow definition into what a canvas draws. Kept out of the React
 * component so the geometry and the graph reading can be tested on their own.
 */

export type NodeKind = "agent" | "command" | "condition" | "terminal" | "parallel";

export interface GraphEdgeSpec {
  to: string;
  label?: string;
  when?: string;
}

export interface GraphNodeSpec {
  id: string;
  type: NodeKind;
  label?: string;
  detail?: string;
  edges: GraphEdgeSpec[];
  /**
   * A parallel node routes through these rather than through `edges`; they are
   * carried along so that reading the graph (depths, loops) sees the same
   * structure the engine does.
   */
  branches?: string[];
  join?: string;
}

/** Shape of a workflow node as it arrives from the API. */
export interface ApiWorkflowNode {
  id: string;
  type: NodeKind;
  label?: string;
  agent?: string;
  command?: string[];
  cwd?: string;
  inputs?: string[];
  status?: string;
  timeoutMs?: number;
  branches?: string[];
  join?: string;
  edges: Array<{ to: string; when?: string; label?: string }>;
}

/** Collapse a definition node into what the canvas needs to draw it. */
export function toGraphNodes(nodes: ApiWorkflowNode[]): GraphNodeSpec[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type,
    label: n.label ?? n.id,
    detail:
      n.type === "agent"
        ? n.agent
        : n.type === "command"
          ? n.command?.join(" ").slice(0, 40)
          : n.type === "terminal"
            ? n.status
            : n.type === "parallel"
              ? `${n.branches?.length ?? 0} branches`
              : undefined,
    // A parallel node has no edges of its own: it hands control to every
    // branch at once, and the branches carry their own edge into the join.
    edges:
      n.type === "parallel"
        ? (n.branches ?? []).map((to) => ({ to, label: "parallel" }))
        : n.edges.map((e) => ({ to: e.to, label: e.label, when: e.when })),
    ...(n.type === "parallel" ? { branches: n.branches ?? [], join: n.join } : {}),
  }));
}

const COLUMN_WIDTH = 250;
const ROW_HEIGHT = 110;

/** Layered left-to-right placement by BFS depth from the entry node. */
export function autoLayout(nodes: GraphNodeSpec[], entry: string): WorkflowLayout {
  const depth = new Map<string, number>();
  const queue: string[] = [];
  if (nodes.some((n) => n.id === entry)) {
    depth.set(entry, 0);
    queue.push(entry);
  }
  while (queue.length) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const e of nodes.find((n) => n.id === id)?.edges ?? []) {
      if (!depth.has(e.to)) {
        depth.set(e.to, d + 1);
        queue.push(e.to);
      }
    }
  }
  const rows = new Map<number, number>();
  const layout: WorkflowLayout = {};
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    layout[n.id] = { x: d * COLUMN_WIDTH, y: row * ROW_HEIGHT };
  }
  return layout;
}
