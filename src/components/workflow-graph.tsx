"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { WorkflowLayout } from "@/executions/types";
import { cn } from "@/lib/utils";

/**
 * The workflow canvas, shared by the definition view and the execution view.
 * It renders a graph and reports position changes; it never decides anything
 * about the run itself.
 */

export type NodeStatus = "idle" | "running" | "completed" | "failed";
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

const KIND_STYLE: Record<NodeKind, string> = {
  agent: "border-sky-500/50 bg-sky-500/10",
  command: "border-amber-500/50 bg-amber-500/10",
  condition: "border-violet-500/50 bg-violet-500/10",
  terminal: "border-emerald-500/50 bg-emerald-500/10",
  parallel: "border-fuchsia-500/50 bg-fuchsia-500/10",
};

const STATUS_STYLE: Record<NodeStatus, string> = {
  idle: "",
  running: "ring-2 ring-sky-400 animate-pulse",
  completed: "ring-2 ring-emerald-500",
  failed: "ring-2 ring-destructive",
};

type CardData = {
  label: string;
  detail?: string;
  kind: NodeKind;
  status: NodeStatus;
  selected: boolean;
};

function NodeCard({ data }: NodeProps) {
  const d = data as CardData;
  return (
    <div
      className={cn(
        "w-[180px] rounded-md border px-3 py-2 text-left shadow-sm",
        KIND_STYLE[d.kind],
        STATUS_STYLE[d.status],
        d.selected && "outline outline-2 outline-offset-2 outline-foreground/40",
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-none !bg-muted-foreground" />
      <div className="truncate text-xs font-medium">{d.label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-wide">{d.kind}</span>
        {d.detail && <span className="truncate font-mono">{d.detail}</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!size-2 !border-none !bg-muted-foreground" />
    </div>
  );
}

const nodeTypes = { workflow: NodeCard };

export interface WorkflowGraphProps {
  nodes: GraphNodeSpec[];
  entry: string;
  layout?: WorkflowLayout;
  statuses?: Record<string, NodeStatus>;
  /** Edges to highlight, keyed "from->to". */
  activeEdges?: Set<string>;
  selected?: string | null;
  onSelect?: (nodeId: string | null) => void;
  onLayoutChange?: (layout: WorkflowLayout) => void;
  className?: string;
}

export function WorkflowGraph({
  nodes,
  entry,
  layout,
  statuses,
  activeEdges,
  selected,
  onSelect,
  onLayoutChange,
  className,
}: WorkflowGraphProps) {
  const fallback = useMemo(() => autoLayout(nodes, entry), [nodes, entry]);
  const [moved, setMoved] = useState<WorkflowLayout>({});

  const positions = useMemo(() => {
    const out: WorkflowLayout = {};
    for (const n of nodes) out[n.id] = moved[n.id] ?? layout?.[n.id] ?? fallback[n.id];
    return out;
  }, [nodes, moved, layout, fallback]);

  const rfNodes: Node[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: "workflow",
        position: positions[n.id],
        data: {
          label: n.label ?? n.id,
          detail: n.detail,
          kind: n.type,
          status: statuses?.[n.id] ?? "idle",
          selected: selected === n.id,
        } satisfies CardData,
      })),
    [nodes, positions, statuses, selected],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      nodes.flatMap((n) =>
        n.edges.map((e, i) => {
          const active = activeEdges?.has(`${n.id}->${e.to}`) ?? false;
          return {
            id: `${n.id}-${e.to}-${i}`,
            source: n.id,
            target: e.to,
            label: e.label ?? e.when,
            animated: active,
            style: active ? { stroke: "hsl(var(--primary))", strokeWidth: 2 } : undefined,
            labelStyle: { fontSize: 10 },
          };
        }),
      ),
    [nodes, activeEdges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let next: WorkflowLayout | null = null;
      for (const c of changes) {
        if (c.type !== "position" || !c.position) continue;
        next = { ...(next ?? moved), [c.id]: c.position };
      }
      if (next) setMoved(next);
      if (onLayoutChange && changes.some((c) => c.type === "position" && !c.dragging)) {
        onLayoutChange({ ...positions, ...(next ?? {}) });
      }
    },
    [moved, positions, onLayoutChange],
  );

  return (
    <div className={cn("h-[520px] w-full rounded-md border bg-muted/20", className)}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        onPaneClick={() => onSelect?.(null)}
        nodesConnectable={false}
        edgesFocusable={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
