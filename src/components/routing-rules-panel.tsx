"use client";

import { useEffect, useState } from "react";
import { Route, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Tier = "haiku" | "sonnet" | "opus" | "fable";
type Effort = "none" | "low" | "medium" | "high";

interface RoutingConfig {
  tiers: Record<Tier, string>;
  thresholds: { largeContext: number; trivial: number };
  categories: Record<string, Tier>;
  effort: Record<string, Effort>;
}

const CATEGORIES: { key: string; label: string; hint: string }[] = [
  { key: "background", label: "Background / utility", hint: "Titles, summaries, tiny replies" },
  { key: "trivial", label: "Trivial / short", hint: "Small prompts, no tools" },
  { key: "agentic", label: "Agentic", hint: "Requests that use tools" },
  { key: "default", label: "Default", hint: "Everything else" },
  { key: "largeContext", label: "Large context", hint: "Very long inputs" },
  { key: "heavy", label: "Heavy reasoning", hint: "\"think hard\", deep dives" },
];

const TIERS: Tier[] = ["haiku", "sonnet", "opus", "fable"];
const EFFORTS: Effort[] = ["none", "low", "medium", "high"];

const selectCls = "h-8 rounded-md border border-input bg-transparent px-2 text-sm";

export function RoutingRulesPanel() {
  const [cfg, setCfg] = useState<RoutingConfig | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsSource, setModelsSource] = useState<"live" | "fallback" | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/routing").then((r) => r.json()).then(setCfg);
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        setModels(d.models ?? []);
        setModelsSource(d.source ?? null);
      })
      .catch(() => {});
  }, []);

  async function save() {
    if (!cfg) return;
    await fetch("/api/routing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categories: cfg.categories, effort: cfg.effort, tiers: cfg.tiers, thresholds: cfg.thresholds }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  if (!cfg) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="size-4" /> Model routing rules
        </CardTitle>
        <CardDescription>Which model — and how much thinking — for each difficulty.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between px-2.5 text-[11px] text-muted-foreground">
            <span>Difficulty</span>
            <span className="flex gap-2">
              <span className="w-24">Model</span>
              <span className="w-20">Thinking</span>
            </span>
          </div>
          {CATEGORIES.map((c) => (
            <div key={c.key} className="flex items-center justify-between gap-3 rounded-md border p-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">{c.label}</div>
                <div className="truncate text-xs text-muted-foreground">{c.hint}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <select
                  value={cfg.categories[c.key]}
                  onChange={(e) => setCfg({ ...cfg, categories: { ...cfg.categories, [c.key]: e.target.value as Tier } })}
                  className={`${selectCls} w-24 capitalize`}
                >
                  {TIERS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select
                  value={cfg.effort?.[c.key] ?? "none"}
                  onChange={(e) => setCfg({ ...cfg, effort: { ...cfg.effort, [c.key]: e.target.value as Effort } })}
                  className={`${selectCls} w-20 capitalize`}
                  title="Extended-thinking effort for this difficulty"
                >
                  {EFFORTS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Model version per tier</Label>
            {modelsSource && (
              <span className="text-[11px] text-muted-foreground">{modelsSource === "live" ? "from your account" : "known list"}</span>
            )}
          </div>
          <div className="mt-2 grid gap-2">
            {TIERS.map((t) => {
              const current = cfg.tiers[t];
              const options = models.includes(current) ? models : [current, ...models];
              return (
                <div key={t} className="flex items-center gap-2">
                  <span className="w-16 text-sm capitalize">{t}</span>
                  <select
                    value={current}
                    onChange={(e) => setCfg({ ...cfg, tiers: { ...cfg.tiers, [t]: e.target.value } })}
                    className={`${selectCls} flex-1 font-mono text-xs`}
                  >
                    {options.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Large-context threshold (tokens)</Label>
            <Input
              type="number"
              className="mt-1 h-8"
              value={cfg.thresholds.largeContext}
              onChange={(e) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, largeContext: Number(e.target.value) } })}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Trivial threshold (tokens)</Label>
            <Input
              type="number"
              className="mt-1 h-8"
              value={cfg.thresholds.trivial}
              onChange={(e) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, trivial: Number(e.target.value) } })}
            />
          </div>
        </div>

        <Button onClick={save} size="sm">
          <Save /> {saved ? "Saved" : "Save routing"}
        </Button>
      </CardContent>
    </Card>
  );
}
