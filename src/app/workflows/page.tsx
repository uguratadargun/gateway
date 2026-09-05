"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectBox, SelectionBar, deleteMany, useSelection } from "@/components/bulk-select";

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
  const [busy, setBusy] = useState(false);
  const selection = useSelection(workflows.map((w) => w.id));

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

  async function removeSelected() {
    const ids = [...selection.selected];
    if (!ids.length) return;
    const many = ids.length > 1;
    if (
      !confirm(
        `Delete ${ids.length} workflow${many ? "s" : ""}? The file${many ? "s are" : " is"} removed from ` +
          `~/.gate/workflows. Runs already recorded are kept.`,
      )
    ) {
      return;
    }
    setBusy(true);
    const failed = await deleteMany((id) => `/api/workflows/${id}`, ids);
    setBusy(false);
    setError(failed.length ? `could not delete ${failed.join(", ")}` : null);
    selection.clear();
    await load();
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
          <SelectionBar
            selection={selection}
            total={workflows.length}
            noun="workflows"
            onDelete={removeSelected}
            busy={busy}
          />
          {workflows.map((w) => (
            <Card key={w.id} className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/40">
              <SelectBox
                checked={selection.selected.has(w.id)}
                onChange={() => selection.toggle(w.id)}
                label={`Select ${w.id}`}
              />
              <Link href={`/workflows/${w.id}`} className="flex min-w-0 flex-1 items-center gap-3">
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
              </Link>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
