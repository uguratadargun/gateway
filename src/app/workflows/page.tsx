"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectHandle, SelectionBar, deleteMany, rowClass, useSelection } from "@/components/bulk-select";
import { TeamPicker, moveMany, useTeamScope, withTeam } from "@/components/team-picker";

interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  entry: string;
  maxWorkflowSteps: number;
  maxVisits: number;
  maxCostUsd: number;
  nodes: Array<{ id: string; type: string }>;
  updatedAt: number;
}

const TEMPLATE = (id: string) => `name: ${id}
description: What this pipeline does.
entry: start
# Uncapped by default. Add "maxWorkflowSteps:" / "maxVisits:" to stop a loop
# that would otherwise only end when you stop it from this dashboard.
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
  /** Runnable here, owned by the default team. */
  const [inherited, setInherited] = useState<WorkflowSummary[]>([]);
  const [newId, setNewId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Broken files are selectable too. A definition that does not parse is
  // exactly the one you need to move or delete, and leaving it out of the
  // selection was how a workflow whose agents had moved became unreachable:
  // visible in the error card, actionable nowhere.
  const selection = useSelection([...workflows.map((w) => w.id), ...errors.map((e) => e.id)]);
  const { team, setTeam, teams, ready } = useTeamScope();
  /** Shipped definitions this team does not have; see /api/defaults. */
  const [missingDefaults, setMissingDefaults] = useState<string[]>([]);

  const load = useCallback(async () => {
    const r = await fetch(withTeam("/api/workflows", team));
    const data = await r.json();
    setWorkflows(data.workflows);
    setErrors(data.errors);
    setInherited(data.inherited ?? []);
  }, [team]);
  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  useEffect(() => {
    if (!ready) return;
    fetch(withTeam("/api/defaults", team))
      .then((r) => r.json())
      .then((d) => setMissingDefaults(d.workflows ?? []))
      .catch(() => setMissingDefaults([]));
  }, [ready, team, workflows.length]);

  /** Writes back the shipped definitions this team is missing. */
  async function restoreDefaults() {
    setBusy(true);
    const r = await fetch(withTeam("/api/defaults", team), { method: "POST" });
    setBusy(false);
    if (!r.ok) {
      setError((await r.json()).error ?? "could not restore the defaults");
      return;
    }
    setMissingDefaults([]);
    await load();
  }

  async function create() {
    const id = newId.trim();
    if (!id) return;
    const r = await fetch(withTeam("/api/workflows", team), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, source: TEMPLATE(id) }),
    });
    if (!r.ok) {
      setError((await r.json()).error ?? "could not create workflow");
      return;
    }
    router.push(withTeam(`/workflows/${id}`, team));
  }

  /**
   * Hands the selected workflows to another team. A workflow is written into
   * the destination through the same validation a hand-edited file gets, so
   * one whose agents are still behind is refused there and stays here — named,
   * rather than moved and quietly broken.
   */
  async function moveSelected(to: string) {
    const ids = [...selection.selected];
    if (!ids.length) return;
    const target = teams.find((t) => t.id === to)?.name ?? to;
    if (
      !confirm(
        `Move ${ids.length} workflow${ids.length > 1 ? "s" : ""} to ${target}? ` +
          `Each one needs the agents it names to be in ${target} too — move those first if they are not.`,
      )
    ) {
      return;
    }
    setBusy(true);
    const failed = await moveMany((id) => withTeam(`/api/workflows/${id}/move`, team), ids, to);
    setBusy(false);
    setError(failed.length ? failed.map((f) => `${f.id}: ${f.error}`).join("; ") : null);
    selection.clear();
    await load();
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
    const failed = await deleteMany((id) => withTeam(`/api/workflows/${id}`, team), ids);
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
            Declarative agent pipelines in ~/.gate/teams/{team}/workflows. The engine picks the next node, never the
            model.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TeamPicker team={team} teams={teams} onChange={setTeam} />
          <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
            <RefreshCw />
          </Button>
        </div>
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

      {missingDefaults.length > 0 && (
        <Card className="flex flex-wrap items-center gap-3 border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <span>
            This team does not have the shipped workflows: <span className="font-mono">{missingDefaults.join(", ")}</span>.
            Restoring writes only what is missing — anything you have edited stays as it is.
          </span>
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={restoreDefaults}>
            Restore
          </Button>
        </Card>
      )}

      {errors.length > 0 && (
        <Card className="border-destructive/50 p-4">
          <div className="text-sm font-medium text-destructive">Files that failed to parse</div>
          <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
            {errors.map((e) => (
              <li key={e.id} className="group flex items-center gap-2">
                <SelectHandle
                  checked={selection.selected.has(e.id)}
                  active={selection.active}
                  onChange={() => selection.toggle(e.id)}
                  label={`Select ${e.id}`}
                />
                <span>
                  {e.id}.yaml — {e.message}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Tick one to move or delete it — an agent it names may have moved to another team.
          </p>
        </Card>
      )}

      {inherited.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-medium">Shared by the Default team</div>
          <p className="mt-1 text-xs text-muted-foreground">
            This team can run these; they belong to Default and are edited there. Save one here under the same id to
            replace it for this team only.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {inherited.map((w) => (
              <li key={w.id} className="flex items-center gap-2">
                <span className="font-medium">{w.id}</span>
                <span className="text-xs text-muted-foreground">
                  {w.name}
                  {w.description ? ` — ${w.description}` : ""}
                </span>
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
            <Card key={w.id} className={rowClass(selection.selected.has(w.id))}>
              <SelectHandle
                checked={selection.selected.has(w.id)}
                active={selection.active}
                onChange={() => selection.toggle(w.id)}
                label={`Select ${w.id}`}
              />
              <Link href={withTeam(`/workflows/${w.id}`, team)} className="flex min-w-0 flex-1 items-center gap-3">
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
          <SelectionBar
            selection={selection}
            total={workflows.length + errors.length}
            noun="workflows"
            onDelete={removeSelected}
            busy={busy}
            moveTo={{ teams, current: team, onMove: moveSelected }}
          />
        </div>
      )}
    </main>
  );
}
