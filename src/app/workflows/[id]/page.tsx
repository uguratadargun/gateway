"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Code2, Play, Save, Trash2 } from "lucide-react";

import { WorkflowGraph, toGraphNodes, type ApiWorkflowNode } from "@/components/workflow-graph";
import { Badge } from "@/components/ui/badge";
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

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [wf, setWf] = useState<ApiWorkflow | null>(null);
  const [source, setSource] = useState("");
  const [saved, setSaved] = useState("");
  const [layout, setLayout] = useState<WorkflowLayout>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [input, setInput] = useState("{}");
  const [requiredInput, setRequiredInput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/workflows/${id}`);
    const data = await r.json();
    if (!r.ok) {
      setError(data.error);
      return;
    }
    setWf(data.workflow);
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
    setSaved(source);
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

  const graphNodes = useMemo(() => (wf ? toGraphNodes(wf.nodes) : []), [wf]);
  const node = wf?.nodes.find((n) => n.id === selected) ?? null;
  const dirty = source !== saved;

  return (
    <main className="mx-auto max-w-6xl space-y-4 px-6 py-8">
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
              {wf ? `${wf.nodes.length} nodes · entry ${wf.entry} · max ${wf.maxWorkflowSteps} steps / ${wf.maxVisits} visits` : "…"}
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
          <Button variant="outline" onClick={() => setShowSource((s) => !s)}>
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
        <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
          <WorkflowGraph
            nodes={graphNodes}
            entry={wf?.entry ?? ""}
            layout={layout}
            selected={selected}
            onSelect={setSelected}
            onLayoutChange={persistLayout}
          />
          <div className="space-y-4">
            <Card className="space-y-2 p-4 text-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {node ? "Node" : "Select a node"}
              </div>
              {node ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{node.id}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {node.type}
                    </Badge>
                  </div>
                  {node.agent && (
                    <p className="text-xs">
                      agent{" "}
                      <Link href={`/agents/${node.agent}`} className="font-mono underline underline-offset-2">
                        {node.agent}
                      </Link>
                    </p>
                  )}
                  {node.command && (
                    <p className="break-all font-mono text-[11px] text-muted-foreground">{node.command.join(" ")}</p>
                  )}
                  {node.branches && (
                    <p className="text-xs">
                      runs <span className="font-mono">{node.branches.join(", ")}</span> together, then continues at{" "}
                      <span className="font-mono">{node.join}</span>
                    </p>
                  )}
                  {node.inputs && node.inputs.length > 0 && (
                    <div className="text-xs">
                      <div className="text-[11px] uppercase text-muted-foreground">inputs</div>
                      {node.inputs.map((i) => (
                        <Badge key={i} variant="outline" className="mr-1 mt-1 font-mono text-[10px]">
                          {i}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {node.edges.length > 0 && (
                    <div className="text-xs">
                      <div className="text-[11px] uppercase text-muted-foreground">edges</div>
                      <ul className="mt-1 space-y-1 font-mono text-[11px] text-muted-foreground">
                        {node.edges.map((e, i) => (
                          <li key={i}>
                            → {e.to}
                            {e.when && <span className="text-foreground/70"> when {e.when}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Click a node to inspect it. Drag nodes to arrange the canvas — positions are saved separately from
                  the workflow file.
                </p>
              )}
            </Card>

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
