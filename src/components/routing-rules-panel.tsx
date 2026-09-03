"use client";

import { useEffect, useState } from "react";
import { Route, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Tier = "haiku" | "sonnet" | "opus" | "fable";
type Effort = "default" | "low" | "medium" | "high" | "xhigh" | "max";
type Preset = "economy" | "balanced" | "quality";

interface RoutingConfig {
  tiers: Record<Tier, string>;
  thresholds: { largeContext: number; trivial: number; haikuContextMax: number };
  categories: Record<string, Tier>;
  effort: Record<string, Effort>;
  preset: Preset;
  classifier: { enabled: boolean; minTokens: number };
  sticky: { enabled: boolean; minTokens: number };
}

const CATEGORIES: { key: string; label: string; hint: string }[] = [
  { key: "background", label: "Background / utility", hint: "Titles, summaries, tiny replies" },
  { key: "trivial", label: "Trivial / short", hint: "Small prompts, no tools" },
  { key: "agentic", label: "Agentic", hint: "Requests that use tools" },
  { key: "default", label: "Default", hint: "Everything else (graded by Haiku when on)" },
  { key: "largeContext", label: "Large context", hint: "Very long inputs (Sonnet has 1M)" },
  { key: "heavy", label: "Heavy reasoning", hint: "\"think hard\", deep dives" },
];

const TIERS: Tier[] = ["haiku", "sonnet", "opus", "fable"];
const EFFORTS: { v: Effort; label: string }[] = [
  { v: "low", label: "low" },
  { v: "medium", label: "medium" },
  { v: "high", label: "high" },
  { v: "xhigh", label: "xhigh" },
  { v: "max", label: "max" },
  { v: "default", label: "API default (high)" },
];

// Mirrors PRESETS in src/lib/router.ts.
const PRESETS: Record<Preset, { categories: Record<string, Tier>; effort: Record<string, Effort>; blurb: string }> = {
  economy: {
    categories: { background: "haiku", trivial: "haiku", agentic: "sonnet", default: "sonnet", largeContext: "sonnet", heavy: "opus" },
    effort: { background: "low", trivial: "low", agentic: "low", default: "low", largeContext: "low", heavy: "medium" },
    blurb: "Stretch the window: Sonnet or below, low effort.",
  },
  balanced: {
    categories: { background: "haiku", trivial: "haiku", agentic: "sonnet", default: "sonnet", largeContext: "sonnet", heavy: "fable" },
    effort: { background: "low", trivial: "low", agentic: "medium", default: "medium", largeContext: "medium", heavy: "high" },
    blurb: "Anthropic's efficiency-first guidance: Sonnet at medium, top tier for heavy intent.",
  },
  quality: {
    categories: { background: "haiku", trivial: "sonnet", agentic: "opus", default: "sonnet", largeContext: "sonnet", heavy: "fable" },
    effort: { background: "low", trivial: "medium", agentic: "high", default: "high", largeContext: "high", heavy: "xhigh" },
    blurb: "Capability-first: Opus for agents, high effort everywhere.",
  },
};

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
      body: JSON.stringify({
        categories: cfg.categories,
        effort: cfg.effort,
        tiers: cfg.tiers,
        thresholds: cfg.thresholds,
        preset: cfg.preset,
        classifier: cfg.classifier,
        sticky: cfg.sticky,
      }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function applyPreset(p: Preset) {
    if (!cfg) return;
    setCfg({ ...cfg, preset: p, categories: { ...PRESETS[p].categories }, effort: { ...PRESETS[p].effort } });
  }

  if (!cfg) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="size-4" /> Model routing rules
        </CardTitle>
        <CardDescription>Which model — and how much effort — for each difficulty.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <Label className="text-xs text-muted-foreground">Cost / quality preset</Label>
          <div className="mt-2 flex gap-1 rounded-lg border bg-muted/40 p-1 text-sm">
            {(Object.keys(PRESETS) as Preset[]).map((p) => (
              <button
                key={p}
                onClick={() => applyPreset(p)}
                className={`flex-1 rounded-md px-3 py-1.5 capitalize ${cfg.preset === p ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {p}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">{PRESETS[cfg.preset]?.blurb}</p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between px-2.5 text-[11px] text-muted-foreground">
            <span>Difficulty</span>
            <span className="flex gap-2">
              <span className="w-24">Model</span>
              <span className="w-28">Effort</span>
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
                  value={cfg.effort?.[c.key] ?? "default"}
                  onChange={(e) => setCfg({ ...cfg, effort: { ...cfg.effort, [c.key]: e.target.value as Effort } })}
                  className={`${selectCls} w-28`}
                  title="output_config.effort on adaptive models; thinking budget on Haiku"
                >
                  {EFFORTS.map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2 rounded-md border p-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Haiku difficulty grader</div>
              <div className="text-xs text-muted-foreground">Grades "default" requests 1–5 with one tiny Haiku call (cached).</div>
            </div>
            <Switch checked={cfg.classifier.enabled} onCheckedChange={(v) => setCfg({ ...cfg, classifier: { ...cfg.classifier, enabled: v } })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Sticky sessions</div>
              <div className="text-xs text-muted-foreground">Hold model + effort within a conversation so prompt caches keep hitting.</div>
            </div>
            <Switch checked={cfg.sticky.enabled} onCheckedChange={(v) => setCfg({ ...cfg, sticky: { ...cfg.sticky, enabled: v } })} />
          </div>
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

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Large-context (tokens)</Label>
            <Input type="number" className="mt-1 h-8" value={cfg.thresholds.largeContext} onChange={(e) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, largeContext: Number(e.target.value) } })} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Trivial (tokens)</Label>
            <Input type="number" className="mt-1 h-8" value={cfg.thresholds.trivial} onChange={(e) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, trivial: Number(e.target.value) } })} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Haiku max (tokens)</Label>
            <Input type="number" className="mt-1 h-8" value={cfg.thresholds.haikuContextMax} onChange={(e) => setCfg({ ...cfg, thresholds: { ...cfg.thresholds, haikuContextMax: Number(e.target.value) } })} />
          </div>
        </div>

        <Button onClick={save} size="sm">
          <Save /> {saved ? "Saved" : "Save routing"}
        </Button>
      </CardContent>
    </Card>
  );
}
