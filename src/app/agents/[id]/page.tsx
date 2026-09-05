"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Save, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  model: string;
  effort?: string;
  inputs: string[];
  output: { type: string; schema?: Record<string, string> };
  tools: string[];
  timeoutMs?: number;
  prompt: string;
  sourcePath: string;
  updatedAt: number;
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [source, setSource] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/agents/${id}`);
      const data = await r.json();
      if (!r.ok) {
        setError(data.error);
        return;
      }
      setAgent(data.agent);
      setSource(data.source);
      setSaved(data.source);
    })();
  }, [id]);

  const save = useCallback(async () => {
    setBusy(true);
    const r = await fetch(`/api/agents/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const data = await r.json();
    setBusy(false);
    if (!r.ok) {
      setError(data.error ?? "invalid agent");
      return;
    }
    setError(null);
    setAgent(data);
    setSaved(source);
  }, [id, source]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  async function remove() {
    if (!confirm(`Delete agent "${id}"? The file is removed from ~/.gate/agents.`)) return;
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    router.push("/agents");
  }

  const dirty = source !== saved;

  return (
    <main className="mx-auto max-w-6xl space-y-4 px-6 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/agents">
            <Button variant="ghost" size="icon" aria-label="Back">
              <ArrowLeft />
            </Button>
          </Link>
          <div>
            <h1 className="font-mono text-lg font-semibold">{id}</h1>
            <p className="text-xs text-muted-foreground">{agent?.sourcePath ?? "…"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete">
            <Trash2 />
          </Button>
          <Button onClick={save} disabled={busy || !dirty}>
            <Save /> {dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </header>

      {error && (
        <Card className="border-destructive/50 p-3 text-sm text-destructive">{error}</Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          spellCheck={false}
          className="h-[70vh] resize-none font-mono text-xs leading-relaxed"
        />
        <Card className="space-y-3 p-4 text-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Last validated definition
          </div>
          {!agent ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <Field label="name">{agent.name}</Field>
              {agent.description && <Field label="description">{agent.description}</Field>}
              <Field label="model">
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {agent.model}
                </Badge>
                {agent.effort && (
                  <Badge variant="outline" className="ml-1 text-[10px]">
                    {agent.effort}
                  </Badge>
                )}
              </Field>
              <Field label="inputs">
                {agent.inputs.length === 0 ? (
                  <span className="text-muted-foreground">none</span>
                ) : (
                  agent.inputs.map((i) => (
                    <Badge key={i} variant="outline" className="mr-1 font-mono text-[10px]">
                      {i}
                    </Badge>
                  ))
                )}
              </Field>
              <Field label="output">
                <span className="font-mono text-xs">{agent.output.type}</span>
                {agent.output.schema && (
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                    {Object.entries(agent.output.schema).map(([k, v]) => (
                      <li key={k}>
                        {k}: {v}
                      </li>
                    ))}
                  </ul>
                )}
              </Field>
              {agent.timeoutMs && <Field label="timeout">{agent.timeoutMs} ms</Field>}
              <p className="pt-2 text-[11px] text-muted-foreground">
                Invalid definitions are rejected on save and never written to disk. ⌘S saves.
              </p>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
