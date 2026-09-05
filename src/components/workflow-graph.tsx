"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  PanOnScrollMode,
  Panel,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { WorkflowLayout } from "@/executions/types";
import { autoLayout, type GraphNodeSpec, type NodeKind } from "@/workflows/graph-view";
import { loopLinkKeys } from "@/workflows/routing";
import { cn } from "@/lib/utils";

/**
 * The workflow canvas, shared by the definition view and the execution view.
 * It renders a graph and reports position changes; it never decides anything
 * about the run itself.
 */

export type NodeStatus = "idle" | "running" | "completed" | "failed";

export { autoLayout, toGraphNodes } from "@/workflows/graph-view";
export type { ApiWorkflowNode, GraphEdgeSpec, GraphNodeSpec, NodeKind } from "@/workflows/graph-view";

const KIND_STYLE: Record<NodeKind, string> = {
  agent: "border-sky-500/50 bg-sky-500/10",
  command: "border-amber-500/50 bg-amber-500/10",
  condition: "border-violet-500/50 bg-violet-500/10",
  terminal: "border-emerald-500/50 bg-emerald-500/10",
  parallel: "border-fuchsia-500/50 bg-fuchsia-500/10",
};

/** Amber, the same hue the legend names "loops back". */
const LOOP_COLOR = "#f59e0b";

/** Flat colours for the minimap, which cannot read the cards' Tailwind classes. */
const KIND_COLOR: Record<NodeKind, string> = {
  agent: "#0ea5e9",
  command: "#f59e0b",
  condition: "#8b5cf6",
  terminal: "#10b981",
  parallel: "#d946ef",
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
  /** Drag-to-connect is only offered where an outgoing edge is legal. */
  connectable: boolean;
  /** This node sends / receives a loop-back edge, which uses its own handles. */
  loopOut: boolean;
  loopIn: boolean;
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
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        isConnectable={d.connectable}
        className={cn("!border-none !bg-muted-foreground", d.connectable ? "!size-3" : "!size-2")}
      />
      {/* The return path gets its own pair of handles underneath the card, so a
          loop leaves and arrives on a line of its own instead of doubling back
          through the forward flow. */}
      {d.loopIn && (
        <Handle
          id="loop-in"
          type="target"
          position={Position.Bottom}
          isConnectable={false}
          style={{ left: "32%", background: LOOP_COLOR }}
          className="!size-2 !border-none"
        />
      )}
      {d.loopOut && (
        <Handle
          id="loop-out"
          type="source"
          position={Position.Bottom}
          isConnectable={false}
          style={{ left: "68%", background: LOOP_COLOR }}
          className="!size-2 !border-none"
        />
      )}
      <div className="truncate text-xs font-medium">{d.label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-wide">{d.kind}</span>
        {d.detail && <span className="truncate font-mono">{d.detail}</span>}
      </div>
      {d.kind !== "terminal" && (
        <Handle
          id="out"
          type="source"
          position={Position.Right}
          isConnectable={d.connectable}
          className={cn("!border-none", d.connectable ? "!size-3 !bg-primary" : "!size-2 !bg-muted-foreground")}
        />
      )}
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
  /** Turns on drag-to-connect and edge deletion. Node deletion stays explicit. */
  editable?: boolean;
  /** A new edge was drawn. For a parallel node this means "add a branch". */
  onConnect?: (from: string, to: string) => void;
  /** Edges removed from the canvas, identified by their position in the source node. */
  onDeleteEdges?: (refs: Array<{ from: string; index: number }>) => void;
  /**
   * Editing chrome to float over the canvas while it is full screen — the page
   * around it is covered then, so whatever the editor needs has to come along.
   */
  overlayToolbar?: React.ReactNode;
  overlayPanel?: React.ReactNode;
  onFullscreenChange?: (fullscreen: boolean) => void;
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
  editable = false,
  onConnect,
  onDeleteEdges,
  overlayToolbar,
  overlayPanel,
  onFullscreenChange,
  className,
}: WorkflowGraphProps) {
  const fallback = useMemo(() => autoLayout(nodes, entry), [nodes, entry]);

  // Edges that hand control back to an earlier node are what turns a pipeline
  // into a loop ("tests failed → implement again"), so they are drawn as a
  // separate return path instead of disappearing into the forward flow.
  const loops = useMemo(() => {
    // Depths are read from the whole structure — a parallel node routes through
    // its branches and join — but only edges the canvas draws can be styled as
    // a return path, or a node would grow a loop handle with nothing on it.
    const all = loopLinkKeys(nodes, entry);
    const drawn = new Set<string>();
    for (const n of nodes) {
      for (const e of n.edges) {
        const key = `${n.id}->${e.to}`;
        if (all.has(key)) drawn.add(key);
      }
    }
    return drawn;
  }, [nodes, entry]);

  /** One lane per return path, so two loops into the same node stay apart. */
  const loopLane = useMemo(() => {
    const lanes = new Map<string, number>();
    for (const n of nodes) {
      for (const e of n.edges) {
        const key = `${n.id}->${e.to}`;
        if (loops.has(key) && !lanes.has(key)) lanes.set(key, lanes.size);
      }
    }
    return lanes;
  }, [nodes, loops]);

  const cardData = useCallback(
    (n: GraphNodeSpec): CardData => ({
      label: n.label ?? n.id,
      detail: n.detail,
      kind: n.type,
      status: statuses?.[n.id] ?? "idle",
      selected: selected === n.id,
      connectable: editable,
      loopOut: [...loops].some((k) => k.startsWith(`${n.id}->`)),
      loopIn: [...loops].some((k) => k.endsWith(`->${n.id}`)),
    }),
    [statuses, selected, editable, loops],
  );

  /**
   * React Flow owns these node objects: it records each card's measured size on
   * them, and rebuilding the array from scratch on every drag frame throws that
   * away — which is what made cards blink out while being dragged. Changes are
   * applied to this state instead, and definition updates are merged into it.
   */
  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const nodesRef = useRef<Node[]>([]);
  nodesRef.current = rfNodes;
  const knownLayout = useRef<WorkflowLayout>({});

  useEffect(() => {
    setRfNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const old = byId.get(n.id);
        const incoming = layout?.[n.id];
        const known = knownLayout.current[n.id];
        // A position that arrived from outside wins only when it actually
        // changed; otherwise where the user dragged the card stands.
        const moved = incoming && (!known || known.x !== incoming.x || known.y !== incoming.y);
        const position = (moved ? incoming : old?.position) ?? incoming ?? fallback[n.id] ?? { x: 0, y: 0 };
        const data = cardData(n);
        return old ? { ...old, position, data } : { id: n.id, type: "workflow", position, deletable: false, data };
      });
    });
    knownLayout.current = layout ?? {};
  }, [nodes, layout, fallback, cardData]);

  const rfEdges: Edge[] = useMemo(
    () =>
      nodes.flatMap((n) =>
        n.edges.map((e, i) => {
          const key = `${n.id}->${e.to}`;
          const active = activeEdges?.has(key) ?? false;
          const loop = loops.has(key);
          const color = active ? "hsl(var(--primary))" : loop ? LOOP_COLOR : undefined;
          return {
            id: `${n.id}-${e.to}-${i}`,
            source: n.id,
            target: e.to,
            type: loop ? "smoothstep" : "default",
            sourceHandle: loop ? "loop-out" : "out",
            targetHandle: loop ? "loop-in" : "in",
            pathOptions: loop ? { borderRadius: 10, offset: 26 + 20 * (loopLane.get(key) ?? 0) } : undefined,
            label: e.label ?? e.when,
            animated: active,
            // The index is the edge's identity in the workflow file: two edges
            // can share a source and a target and still differ by condition.
            data: { from: n.id, index: i },
            deletable: editable,
            markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
            style: {
              ...(color ? { stroke: color } : {}),
              strokeWidth: active ? 2 : loop ? 1.5 : 1,
              ...(loop ? { strokeDasharray: "6 4" } : {}),
            },
            labelShowBg: true,
            labelBgStyle: { fill: "hsl(var(--background))", fillOpacity: 0.9 },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 4,
            labelStyle: { fontSize: 10, fill: loop ? LOOP_COLOR : "hsl(var(--muted-foreground))" },
          };
        }),
      ),
    [nodes, activeEdges, editable, loops, loopLane],
  );

  // Positions are persisted when a drag ends, not on every frame; the counter
  // hands that over to an effect so the parent is never updated mid-render.
  const [dropped, setDropped] = useState(0);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((prev) => applyNodeChanges(changes, prev));
    if (changes.some((c) => c.type === "position" && c.dragging === false)) setDropped((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!dropped || !onLayoutChange) return;
    const out: WorkflowLayout = {};
    for (const n of nodesRef.current) out[n.id] = { x: n.position.x, y: n.position.y };
    knownLayout.current = out;
    onLayoutChange(out);
    // Only a finished drag should write; re-running on every node change would
    // save the canvas continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    // Escape backs out one level: full screen first, then the selection.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (fullscreen) setFullscreen(false);
      else onSelect?.(null);
    };
    window.addEventListener("keydown", onKey);
    if (!fullscreen) return () => window.removeEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [fullscreen, onSelect]);

  useEffect(() => onFullscreenChange?.(fullscreen), [fullscreen, onFullscreenChange]);

  /** Keeps obviously broken links off the canvas; the file check is the server's. */
  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (!c.source || !c.target || c.source === c.target) return false;
      const from = nodes.find((n) => n.id === c.source);
      if (!from || from.type === "terminal") return false;
      return !from.edges.some((e) => e.to === c.target);
    },
    [nodes],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target) onConnect?.(c.source, c.target);
    },
    [onConnect],
  );

  const handleEdgesDelete = useCallback(
    (edges: Edge[]) => {
      const refs = edges
        .map((e) => e.data as { from: string; index: number } | undefined)
        .filter((d): d is { from: string; index: number } => !!d);
      if (refs.length) onDeleteEdges?.(refs);
    },
    [onDeleteEdges],
  );

  return (
    <div
      className={cn(
        "w-full rounded-md border bg-muted/20",
        "h-[min(72vh,720px)] min-h-[420px]",
        className,
        // Opaque and above everything: the pane itself is transparent, so a
        // translucent background would leave the page showing through.
        fullscreen && "fixed inset-0 z-[60] h-screen min-h-screen w-screen rounded-none border-0 bg-background",
      )}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        onEdgeClick={(_, e) => onSelect?.(e.source)}
        onPaneClick={() => onSelect?.(null)}
        onConnect={handleConnect}
        onEdgesDelete={handleEdgesDelete}
        isValidConnection={isValidConnection}
        nodesConnectable={editable}
        edgesFocusable={editable}
        edgesReconnectable={false}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        // Trackpad-first navigation: two fingers pan in both directions, pinch
        // zooms, and the wheel no longer zooms out from under the pointer.
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={2}
        // Cards land on the same 16px grid the background draws, so a hand-made
        // layout stays as tidy as the generated one.
        snapToGrid
        snapGrid={[16, 16]}
        nodeDragThreshold={1}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          className="!m-2 !h-24 !w-40 overflow-hidden rounded-md border !bg-background/85"
          maskColor="hsl(var(--muted) / 0.6)"
          nodeColor={(n) => KIND_COLOR[(n.data as CardData).kind] ?? "#94a3b8"}
          nodeStrokeWidth={2}
        />
        <Panel position="top-left" className="!m-2">
          <button
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? "Leave full screen (Esc)" : "Full screen"}
            aria-label={fullscreen ? "Leave full screen" : "Full screen"}
            className="rounded-md border bg-background/85 p-1.5 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
          >
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </Panel>
        {fullscreen && overlayToolbar && (
          <Panel position="top-center" className="!m-2 max-w-[calc(100vw-16rem)] rounded-md border bg-background/95 px-2 py-1.5 shadow-sm backdrop-blur">
            {overlayToolbar}
          </Panel>
        )}
        {fullscreen && overlayPanel && (
          <Panel
            position="top-right"
            className="!m-2 max-h-[calc(100vh-4rem)] w-[340px] space-y-3 overflow-y-auto rounded-md border bg-background/95 p-3 shadow-sm backdrop-blur"
          >
            {overlayPanel}
          </Panel>
        )}
        <Panel position="bottom-center" className="pointer-events-none !m-2 flex items-center gap-2 rounded-md border bg-background/85 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
          <span className="flex items-center gap-1">
            <svg width="18" height="6" aria-hidden>
              <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            goes on
          </span>
          <span className="flex items-center gap-1" style={{ color: LOOP_COLOR }}>
            <svg width="18" height="6" aria-hidden>
              <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
            </svg>
            loops back
          </span>
        </Panel>
      </ReactFlow>
    </div>
  );
}
