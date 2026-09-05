"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Code2, LayoutGrid, Play, Plus, Save, Trash2, Undo2 } from "lucide-react";

import {
  WorkflowGraph,
  autoLayout,
  toGraphNodes,
  type ApiWorkflowNode,
  type NodeKind,
} from "@/components/workflow-graph";
import { WorkflowNodeEditor } from "@/components/workflow-node-editor";
import { RoutingSummary } from "@/components/workflow-routing";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { WorkflowLayout } from "@/executions/types";

interface ApiWorkflow {
  id: string;
  name: string;
  description?: string;
  entry: string;
  workspace?: { repo: string; baseRef?: string; branchPrefix?: string };
  maxWorkflowSteps: number;
  maxVisits: number;
  nodes: ApiWorkflowNode[];
  sourcePath: string;
}

/**
 * The editable copy of a workflow. It is exactly what the save endpoint takes,
 * so "what the canvas shows" and "what gets written" never drift apart.
 */
interface Draft {
  name: string;
  description?: string;
  entry: string;
  workspace?: { repo: string; baseRef?: string; branchPrefix?: string };
  maxWorkflowSteps: number;
  maxVisits: number;
  nodes: ApiWorkflowNode[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ADDABLE: NodeKind[] = ["agent", "command", "condition", "parallel", "terminal"];

function toDraft(wf: ApiWorkflow): Draft {
  return {
    name: wf.name,
    description: wf.description,
    entry: wf.entry,
    workspace: wf.workspace,
    maxWorkflowSteps: wf.maxWorkflowSteps,
    maxVisits: wf.maxVisits,
    nodes: wf.nodes.map((n) => ({
      ...n,
      edges: (n.edges ?? []).map((e) => ({ to: e.to, when: e.when, label: e.label })),
    })),
  };
}

function freshId(kind: NodeKind, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const id = i === 1 ? kind : `${kind}-${i}`;
    if (!taken.has(id)) return id;
  }
}

function blankNode(kind: NodeKind, id: string, firstAgent: string | undefined): ApiWorkflowNode {
  const base = { id, type: kind, edges: [] as ApiWorkflowNode["edges"] };
  switch (kind) {
    case "agent":
      return { ...base, agent: firstAgent ?? "" };
    case "command":
      return { ...base, command: ["npm", "test"] };
    case "terminal":
      return { ...base, status: "completed" };
    case "parallel":
      return { ...base, branches: [], join: "" };
    default:
      return base;
  }
}

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [wf, setWf] = useState<ApiWorkflow | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [source, setSource] = useState("");
  const [saved, setSaved] = useState("");
  const [layout, setLayout] = useState<WorkflowLayout>({});
  const [agents, setAgents] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [input, setInput] = useState("{}");
  const [requiredInput, setRequiredInput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** While the canvas is full screen the page chrome is covered, so it moves onto the canvas. */
  const [canvasFull, setCanvasFull] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/workflows/${id}`);
    const data = await r.json();
    if (!r.ok) {
      setError(data.error);
      return;
    }
    setWf(data.workflow);
    setDraft(toDraft(data.workflow));
    setSource(data.source);
    setSaved(data.source);
    setLayout(data.layout ?? {});
    const required: string[] = data.requiredInput ?? [];
    setRequiredInput(required);
    if (required.length) {
      setInput((current) =>
        current.trim() === "{}" ? JSON.stringify(Object.fromEntries(required.map((k) => [k, ""])), null, 2) : current,
      );
    }
  }, [id]);

  useEffect(() => {
    load();
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => setAgents((d.agents ?? []).map((a: { id: string }) => a.id)))
      .catch(() => {});
  }, [load]);

  async function save() {
    const r = await fetch(`/api/workflows/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "invalid workflow");
      return;
    }
    setError(null);
    setWf(data);
    setDraft(toDraft(data));
    setSaved(source);
  }

  /** The graph editor writes the file too: the server serializes and validates it. */
  async function saveGraph() {
    if (!draft) return;
    const r = await fetch(`/api/workflows/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph: draft }),
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "invalid workflow");
      return;
    }
    setError(null);
    await load();
  }

  async function remove() {
    if (!confirm(`Delete workflow "${id}"? The file is removed from ~/.gate/workflows.`)) return;
    await fetch(`/api/workflows/${id}`, { method: "DELETE" });
    router.push("/workflows");
  }

  async function run() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input || "{}");
    } catch {
      setError("run input must be valid JSON");
      return;
    }
    const r = await fetch("/api/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: id, input: parsed }),
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "could not start run");
      return;
    }
    router.push(`/executions/${data.executionId}`);
  }

  const persistLayout = useCallback(
    (next: WorkflowLayout) => {
      setLayout(next);
      fetch(`/api/workflows/${id}/layout`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {});
    },
    [id],
  );

  const graphNodes = useMemo(() => (draft ? toGraphNodes(draft.nodes) : []), [draft]);
  const node = draft?.nodes.find((n) => n.id === selected) ?? null;
  const dirty = source !== saved;
  const graphDirty = !!wf && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(wf));

  const edit = useCallback((fn: (d: Draft) => Draft) => {
    setError(null);
    setDraft((d) => (d ? fn(d) : d));
  }, []);

  function addNode(kind: NodeKind) {
    if (!draft) return;
    const id = freshId(kind, new Set(draft.nodes.map((n) => n.id)));
    const positions = { ...autoLayout(graphNodes, draft.entry), ...layout };
    const anchor = (selected && positions[selected]) || null;
    const spread = Object.values(positions);
    const place = anchor
      ? { x: anchor.x + 260, y: anchor.y + 40 }
      : { x: Math.max(0, ...spread.map((p) => p.x)) + 60, y: Math.max(0, ...spread.map((p) => p.y)) + 120 };
    edit((d) => ({ ...d, nodes: [...d.nodes, blankNode(kind, id, agents[0])] }));
    persistLayout({ ...positions, [id]: place });
    setSelected(id);
  }

  /** A new link from a parallel node means one more branch, not an edge. */
  function connect(from: string, to: string) {
    edit((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        if (n.id !== from) return n;
        if (n.type === "parallel") {
          const branches = n.branches ?? [];
          return branches.includes(to) || branches.length >= 10 ? n : { ...n, branches: [...branches, to] };
        }
        const edges = n.edges ?? [];
        return edges.some((e) => e.to === to) ? n : { ...n, edges: [...edges, { to }] };
      }),
    }));
  }

  function deleteEdges(refs: Array<{ from: string; index: number }>) {
    const byNode = new Map<string, Set<number>>();
    for (const r of refs) {
      const set = byNode.get(r.from) ?? new Set<number>();
      set.add(r.index);
      byNode.set(r.from, set);
    }
    edit((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        const drop = byNode.get(n.id);
        if (!drop) return n;
        if (n.type === "parallel") return { ...n, branches: (n.branches ?? []).filter((_, i) => !drop.has(i)) };
        return { ...n, edges: (n.edges ?? []).filter((_, i) => !drop.has(i)) };
      }),
    }));
  }

  /** Removing a node takes every reference to it with it, so the graph stays whole. */
  function deleteNode(id: string) {
    if (!draft || draft.nodes.length <= 1) return;
    edit((d) => {
      const nodes = d.nodes
        .filter((n) => n.id !== id)
        .map((n) => ({
          ...n,
          edges: (n.edges ?? []).filter((e) => e.to !== id),
          ...(n.type === "parallel"
            ? { branches: (n.branches ?? []).filter((b) => b !== id), join: n.join === id ? "" : n.join }
            : {}),
        }));
      return { ...d, nodes, entry: d.entry === id ? (nodes[0]?.id ?? "") : d.entry };
    });
    setSelected(null);
  }

  function renameNode(from: string, to: string) {
    const next = to.trim();
    if (!draft || next === from) return;
    if (!ID_RE.test(next)) {
      setError("node ids use lowercase letters, digits and dashes");
      return;
    }
    if (draft.nodes.some((n) => n.id === next)) {
      setError(`node "${next}" already exists`);
      return;
    }
    edit((d) => ({
      ...d,
      entry: d.entry === from ? next : d.entry,
      nodes: d.nodes.map((n) => ({
        ...n,
        id: n.id === from ? next : n.id,
        edges: (n.edges ?? []).map((e) => (e.to === from ? { ...e, to: next } : e)),
        ...(n.type === "parallel"
          ? { branches: (n.branches ?? []).map((b) => (b === from ? next : b)), join: n.join === from ? next : n.join }
          : {}),
      })),
    }));
    if (layout[from]) persistLayout({ ...layout, [next]: layout[from] });
    setSelected(next);
  }

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Add</span>
      {ADDABLE.map((kind) => (
        <Button
          key={kind}
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          disabled={!draft}
          onClick={() => addNode(kind)}
        >
          <Plus className="size-3" /> {kind}
        </Button>
      ))}
      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          disabled={!draft}
          title="Lay the nodes out again, left to right"
          onClick={() => draft && persistLayout(autoLayout(graphNodes, draft.entry))}
        >
          <LayoutGrid className="size-3" /> Tidy up
        </Button>
        {graphDirty && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => {
              setError(null);
              if (wf) setDraft(toDraft(wf));
            }}
          >
            <Undo2 className="size-3" /> Revert
          </Button>
        )}
        <Button size="sm" className="h-7 text-[11px]" onClick={saveGraph} disabled={!graphDirty}>
          <Save className="size-3" /> {graphDirty ? "Save graph" : "Saved"}
        </Button>
      </div>
    </div>
  );

  const nodeCard = (
    <Card className="space-y-2 p-4 text-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {node ? "Node" : "Select a node"}
      </div>
      {node && draft ? (
        <WorkflowNodeEditor
          node={node}
          nodes={draft.nodes}
          agents={agents}
          isEntry={draft.entry === node.id}
          onChange={(patch) =>
            edit((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)) }))
          }
          onSelectNode={setSelected}
          onRename={(next) => renameNode(node.id, next)}
          onSetEntry={() => edit((d) => ({ ...d, entry: node.id }))}
          onDelete={() => deleteNode(node.id)}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          Click a node to edit it, or add one from the toolbar. Changes stay in the browser until you press Save
          graph, which rewrites the workflow file.
        </p>
      )}
    </Card>
  );

  const routingCard = draft && (
    <Card className="space-y-2 p-4 text-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Routing</div>
      <p className="text-[11px] text-muted-foreground">
        The engine decides where the run goes next — no model does. At each point below it takes the first edge whose
        condition holds, and the last edge without one is the fallback.
      </p>
      <RoutingSummary nodes={draft.nodes} entry={draft.entry} onSelect={setSelected} />
    </Card>
  );

  return (
    <main className="mx-auto max-w-[1500px] space-y-4 px-6 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/workflows">
            <Button variant="ghost" size="icon" aria-label="Back">
              <ArrowLeft />
            </Button>
          </Link>
          <div>
            <h1 className="text-lg font-semibold">{wf?.name ?? id}</h1>
            <p className="text-xs text-muted-foreground">
              {wf
                ? `${draft?.nodes.length ?? wf.nodes.length} nodes · entry ${draft?.entry ?? wf.entry} · max ${wf.maxWorkflowSteps} steps / ${wf.maxVisits} visits`
                : "…"}
            </p>
            {wf?.workspace && (
              <p className="text-[11px] text-muted-foreground">
                worktree of <span className="font-mono">{wf.workspace.repo}</span>
                {wf.workspace.baseRef ? ` @ ${wf.workspace.baseRef}` : ""} — agents get file and command tools
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete">
            <Trash2 />
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (!showSource && graphDirty) {
                setError("save or revert the graph edits before switching to YAML");
                return;
              }
              setError(null);
              setShowSource((s) => !s);
            }}
          >
            <Code2 /> {showSource ? "Graph" : "YAML"}
          </Button>
          <Button onClick={run}>
            <Play /> Run
          </Button>
        </div>
      </header>

      {error && <Card className="border-destructive/50 p-3 text-sm text-destructive">{error}</Card>}

      {showSource ? (
        <div className="space-y-2">
          <Textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            className="h-[65vh] resize-none font-mono text-xs leading-relaxed"
          />
          <div className="flex justify-end">
            <Button onClick={save} disabled={!dirty}>
              <Save /> {dirty ? "Save" : "Saved"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2.3fr)_minmax(320px,1fr)]">
          <div className="space-y-2">
            {!canvasFull && toolbar}
            <WorkflowGraph
              nodes={graphNodes}
              entry={draft?.entry ?? wf?.entry ?? ""}
              layout={layout}
              selected={selected}
              onSelect={setSelected}
              onLayoutChange={persistLayout}
              editable
              onConnect={connect}
              onDeleteEdges={deleteEdges}
              overlayToolbar={toolbar}
              overlayPanel={
                <>
                  {nodeCard}
                  {routingCard}
                </>
              }
              onFullscreenChange={setCanvasFull}
            />
            {!canvasFull && (
              <p className="text-[11px] text-muted-foreground">
                Two-finger scroll pans the canvas, pinch zooms. Drag from a node&rsquo;s right handle to another node
                to connect them; click an edge and press Delete to remove it. Full screen keeps the toolbar and the
                inspector on the canvas. Positions are saved separately from the workflow file; saving the graph
                rewrites it, so YAML comments are not preserved.
              </p>
            )}
          </div>
          <div className="space-y-4">
            {!canvasFull && nodeCard}
            {!canvasFull && routingCard}

            <Card className="space-y-2 p-4 text-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Run input</div>
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                spellCheck={false}
                className="h-28 resize-none font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                JSON object, readable by nodes as <span className="font-mono">input.*</span>.
                {requiredInput.length > 0 && (
                  <>
                    {" "}
                    This workflow needs <span className="font-mono">{requiredInput.join(", ")}</span>.
                  </>
                )}
              </p>
            </Card>
          </div>
        </div>
      )}
    </main>
  );
}
