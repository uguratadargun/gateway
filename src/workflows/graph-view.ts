import type { WorkflowLayout } from "@/executions/types";

import { loopLinkKeys } from "./routing";

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

export const COLUMN_WIDTH = 250;
const ROW_HEIGHT = 110;

/**
 * Layered left-to-right placement, with the main path on one line.
 *
 * Columns come from the **longest** path from the entry, over every edge
 * that is not a return path. Not the shortest: a shortcut edge that skips a
 * gate — "the plan is already approved, straight to the implementer" — would
 * otherwise pull the implementer up beside the gate it skips, and the gate's
 * own edge into it would then run backwards, through the cards in between.
 * Read by the longest road, every forward edge points right and a shortcut
 * is drawn as what it is: a line that passes over the columns it skips.
 *
 * Within a column, the node with the longest forward path ahead of it — the
 * spine — sits on row 0, so the run's main line reads straight across.
 * Everything else in the column is a side exit (a failed terminal, a hold)
 * or a detour, and goes **above** the spine. Return paths are drawn
 * underneath the cards, from bottom handle to bottom handle, so the space
 * below the spine is theirs: a card placed there would sit on the loop. The
 * one exception is a side node that itself sends a loop back (clarify →
 * planner): its return path leaves from its own bottom edge, so it goes
 * below the spine, where that line does not have to cross the spine's card
 * on the way down.
 */
export function autoLayout(nodes: GraphNodeSpec[], entry: string): WorkflowLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const loops = loopLinkKeys(nodes, entry);
  const isLoop = (from: string, to: string) => loops.has(`${from}->${to}`);
  const forward = (id: string) => (byId.get(id)?.edges ?? []).filter((e) => byId.has(e.to) && !isLoop(id, e.to));
  const loopsBack = (id: string) => (byId.get(id)?.edges ?? []).some((e) => isLoop(id, e.to));

  // Longest path from the entry over forward edges. Those edges form a DAG —
  // the return paths are exactly the back edges of a depth-first walk — so a
  // topological order exists, and relaxing along it gives the longest road.
  const depth = new Map<string, number>();
  const topo: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of forward(id)) visit(e.to);
    topo.push(id);
  };
  if (byId.has(entry)) visit(entry);
  topo.reverse();
  if (byId.has(entry)) depth.set(entry, 0);
  for (const id of topo) {
    const d = depth.get(id);
    if (d === undefined) continue;
    for (const e of forward(id)) depth.set(e.to, Math.max(depth.get(e.to) ?? 0, d + 1));
  }
  const order = [...topo];
  // Unreachable nodes still get a place: column 0, after everything else.
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id);
  const depthOf = (id: string) => depth.get(id) ?? 0;

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

  // Between two nodes with the same road ahead — the last column, where the
  // happy ending and a failed exit both have nothing after them — the row
  // goes to the one that is not a failure, so the main line ends on "done".
  const failedExit = (id: string) => {
    const n = byId.get(id);
    return n?.type === "terminal" && n.detail === "failed";
  };
  const ahead = (a: string, b: string) =>
    reachOf(a) > reachOf(b) || (reachOf(a) === reachOf(b) && !failedExit(a) && failedExit(b));

  const layout: WorkflowLayout = {};
  for (const [d, ids] of columns) {
    let spine = ids[0];
    for (const id of ids) if (ahead(id, spine)) spine = id;
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

/**
 * Forward edges that do not go to the next column over: a shortcut that
 * skips a gate, an exit to a terminal placed further along, or — in a
 * hand-made layout — an edge whose target has been dragged to the left.
 * Drawn as a straight line each of them would cut through whatever cards
 * stand between, so the canvas gives them a lane above the cards, the mirror
 * of what return paths get below.
 */
export function skipKeys(
  nodes: GraphNodeSpec[],
  positions: Record<string, { x: number; y: number } | undefined>,
  loops: Set<string>,
): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    const from = positions[n.id];
    if (!from) continue;
    for (const e of n.edges) {
      const key = `${n.id}->${e.to}`;
      const to = positions[e.to];
      if (!to || loops.has(key)) continue;
      const dx = to.x - from.x;
      if (dx < COLUMN_WIDTH * 0.5 || dx > COLUMN_WIDTH * 1.5) out.add(key);
    }
  }
  return out;
}
