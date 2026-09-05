"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  entry: string;
  maxWorkflowSteps: number;
  maxVisits: number;
  nodes: Array<{ id: string; type: string }>;
  updatedAt: number;
}

const TEMPLATE = (id: string) => `name: ${id}
description: What this pipeline does.
entry: start
maxWorkflowSteps: 50
maxVisits: 5
nodes:
  - id: start
    type: command
    command: ["echo", "replace me with an agent node"]
    next: done

  - id: done
    type: terminal
    status: completed
`;

export default function WorkflowsPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [errors, setErrors] = useState<Array<{ id: string; message: string }>>([]);
  const [newId, setNewId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/workflows");
    const data = await r.json();
    setWorkflows(data.workflows);
    setErrors(data.errors);
  }
  useEffect(() => {
    load();
  }, []);

  async function create() {
    const id = newId.trim();
    if (!id) return;
    const r = await fetch("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, source: TEMPLATE(id) }),
    });
    if (!r.ok) {
      setError((await r.json()).error ?? "could not create workflow");
      return;
    }
    router.push(`/workflows/${id}`);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Declarative agent pipelines in ~/.gate/workflows. The engine picks the next node, never the model.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
          <RefreshCw />
        </Button>
      </header>

      <div className="flex items-center gap-2">
        <Input
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="new-workflow-id"
          className="max-w-xs font-mono text-sm"
        />
        <Button onClick={create} disabled={!newId.trim()}>
          <Plus /> New workflow
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {errors.length > 0 && (
        <Card className="border-destructive/50 p-4">
          <div className="text-sm font-medium text-destructive">Files that failed to parse</div>
          <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
            {errors.map((e) => (
              <li key={e.id}>
                {e.id}.yaml — {e.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {workflows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No workflows yet.</p>
      ) : (
        <div className="space-y-2">
          {workflows.map((w) => (
            <Link key={w.id} href={`/workflows/${w.id}`}>
              <Card className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/40">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{w.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {w.description ?? <span className="font-mono">{w.id}.yaml</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <span>{w.nodes.length} nodes</span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    entry: {w.entry}
                  </Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
