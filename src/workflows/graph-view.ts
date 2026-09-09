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
  /** Switched off: drawn, but nothing a run will do. */
  disabled?: boolean;
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
  disabled?: boolean;
  skipTo?: string;
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
    disabled: n.disabled,
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

/**
 * Layered left-to-right placement, with the main path on one line.
 *
 * Columns come from BFS depth. Within a column, the node with the longest
 * forward path ahead of it — the spine — sits on row 0, so the run's main
 * line reads straight across. Everything else in the column is a side exit
 * (a failed terminal, a hold) or a detour, and goes **above** the spine.
 * Return paths are drawn underneath the cards, from bottom handle to bottom
 * handle, so the space below the spine is theirs: a card placed there would
 * sit on the loop. The one exception is a side node that itself sends a loop
 * back (clarify → planner): its return path leaves from its own bottom edge,
 * so it goes below the spine, where that line does not have to cross the
 * spine's card on the way down.
 */
export function autoLayout(nodes: GraphNodeSpec[], entry: string): WorkflowLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const order: string[] = [];
  const queue: string[] = [];
  if (byId.has(entry)) {
    depth.set(entry, 0);
    queue.push(entry);
  }
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    const d = depth.get(id) ?? 0;
    for (const e of byId.get(id)?.edges ?? []) {
      if (byId.has(e.to) && !depth.has(e.to)) {
        depth.set(e.to, d + 1);
        queue.push(e.to);
      }
    }
  }
  // Unreachable nodes still get a place: column 0, after everything else.
  for (const n of nodes) if (!depth.has(n.id)) order.push(n.id);
  const depthOf = (id: string) => depth.get(id) ?? 0;

  // A forward edge goes strictly deeper; anything else is a return path.
  const forward = (id: string) => (byId.get(id)?.edges ?? []).filter((e) => depthOf(e.to) > depthOf(id));
  const loopsBack = (id: string) => (byId.get(id)?.edges ?? []).some((e) => byId.has(e.to) && depthOf(e.to) <= depthOf(id));

  /** How far the run can still go from here along forward edges. */
  const reach = new Map<string, number>();
  const reachOf = (id: string): number => {
    const known = reach.get(id);
    if (known !== undefined) return known;
    reach.set(id, 0);
    let best = 0;
    for (const e of forward(id)) best = Math.max(best, 1 + reachOf(e.to));
    reach.set(id, best);
    return best;
  };

  const columns = new Map<number, string[]>();
  for (const id of order) {
    const d = depthOf(id);
    columns.set(d, [...(columns.get(d) ?? []), id]);
  }

  const layout: WorkflowLayout = {};
  for (const [d, ids] of columns) {
    let spine = ids[0];
    for (const id of ids) if (reachOf(id) > reachOf(spine)) spine = id;
    let above = 0;
    let below = 0;
    for (const id of ids) {
      let row: number;
      if (id === spine) row = 0;
      else if (loopsBack(id)) row = ++below;
      else row = -++above;
      layout[id] = { x: d * COLUMN_WIDTH, y: row * ROW_HEIGHT };
    }
  }
  return layout;
}
