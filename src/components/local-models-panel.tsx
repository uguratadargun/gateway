"use client";

import { useCallback, useEffect, useState } from "react";
import { HardDrive, Plus, RefreshCw, Server, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface Provider {
  id: string;
  name: string;
  label: string;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  selfHosted: boolean;
}

interface Catalogue {
  models: string[];
  refs: string[];
  error: string | null;
}

/** Endpoints people actually run, so the form is one click for the common cases. */
const PRESETS: { label: string; name: string; baseUrl: string }[] = [
  { label: "Ollama", name: "ollama", baseUrl: "http://localhost:11434/v1" },
  { label: "LM Studio", name: "lm-studio", baseUrl: "http://localhost:1234/v1" },
  { label: "vLLM", name: "vllm", baseUrl: "http://localhost:8000/v1" },
  { label: "llama.cpp", name: "llama-cpp", baseUrl: "http://localhost:8080/v1" },
];

export function LocalModelsPanel() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [catalogues, setCatalogues] = useState<Record<string, Catalogue>>({});
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", baseUrl: "", apiKey: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/providers");
    const data = await res.json();
    setProviders(data.providers ?? []);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const probe = useCallback(async (id: string, force = false) => {
    const res = await fetch(`/api/providers/${id}/models${force ? "?refresh=1" : ""}`);
    const data = (await res.json()) as Catalogue;
    setCatalogues((c) => ({ ...c, [id]: data }));
  }, []);

  useEffect(() => {
    // Probe on load so a box that is down is visible without asking.
    for (const p of providers ?? []) {
      if (p.enabled) probe(p.id);
    }
  }, [providers, probe]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          baseUrl: form.baseUrl.trim(),
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not add the provider");
        return;
      }
      setForm({ name: "", baseUrl: "", apiKey: "" });
      setAdding(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/providers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await refresh();
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove "${name}"? Any tier pointing at it falls back to the next one.`)) return;
    await fetch(`/api/providers/${id}`, { method: "DELETE" });
    await refresh();
  }

  if (!providers) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <HardDrive /> Local models
          </CardTitle>
          <CardDescription>
            Any endpoint that speaks OpenAI chat/completions — Ollama, vLLM, LM Studio, llama.cpp.
            Point a tier at one under Model routing and gate translates the traffic both ways.
          </CardDescription>
        </div>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add endpoint
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {providers.length === 0 && !adding && (
          <p className="text-sm text-muted-foreground">No local endpoints yet.</p>
        )}

        {providers.map((p) => {
          const cat = catalogues[p.id];
          return (
            <div key={p.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Server className="size-4 text-muted-foreground" />
                    <span className="truncate">{p.label}</span>
                    {p.selfHosted ? (
                      <Badge variant="success">on your network</Badge>
                    ) : (
                      <Badge variant="outline">remote</Badge>
                    )}
                    {p.hasApiKey && <Badge variant="secondary">key set</Badge>}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{p.baseUrl}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon" onClick={() => probe(p.id, true)} title="Test and refresh models">
                    <RefreshCw className="size-4" />
                  </Button>
                  <span title="Available for routing">
                    <Switch checked={p.enabled} onCheckedChange={(v) => patch(p.id, { enabled: v })} />
                  </span>
                  <Button variant="ghost" size="icon" onClick={() => remove(p.id, p.label)} title="Remove">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="mt-2 text-xs">
                {!cat ? (
                  <span className="text-muted-foreground">not checked</span>
                ) : cat.error ? (
                  <span className="text-destructive">unreachable — {cat.error}</span>
                ) : cat.models.length === 0 ? (
                  <span className="text-muted-foreground">reachable, but serving no models</span>
                ) : (
                  <div className="space-y-1">
                    <span className="text-muted-foreground">{cat.models.length} model(s):</span>
                    <div className="flex flex-wrap gap-1">
                      {cat.refs.slice(0, 8).map((ref) => (
                        <code key={ref} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                          {ref}
                        </code>
                      ))}
                      {cat.refs.length > 8 && (
                        <span className="text-muted-foreground">+{cat.refs.length - 8} more</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {adding && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.name}
                  variant="outline"
                  size="sm"
                  onClick={() => setForm((f) => ({ ...f, name: preset.name, baseUrl: preset.baseUrl }))}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="p-name">Name</Label>
                <Input
                  id="p-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="ollama"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="p-url">Base URL</Label>
                <Input
                  id="p-url"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder="http://localhost:11434/v1"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="p-key">API key (optional)</Label>
                <Input
                  id="p-key"
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder="none for Ollama"
                  autoComplete="off"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Models become <code className="font-mono">local:{form.name.trim() || "<name>"}/&lt;model&gt;</code>.
              The base URL is the one ending in <code className="font-mono">/v1</code>.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={add} disabled={busy || !form.name.trim() || !form.baseUrl.trim()}>
                Add
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setError(null); }}>
                Cancel
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
