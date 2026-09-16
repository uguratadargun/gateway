"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, Layers, SlidersHorizontal } from "lucide-react";

import { SaveRow } from "@/components/save-row";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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
  overrideExplicit: boolean;
}

/**
 * What each card owns. A card saves these keys and nothing else, so editing the
 * tier table cannot write back a stale copy of the difficulty table.
 */
const OWNS = {
  difficulty: ["preset", "categories", "effort"],
  decide: ["classifier", "sticky", "thresholds", "overrideExplicit"],
  tiers: ["tiers"],
} as const satisfies Record<string, readonly (keyof RoutingConfig)[]>;

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

/** One source of models: the connected Claude account, or a provider. */
interface ModelGroup {
  label: string;
  kind: "anthropic" | "provider";
  selfHosted: boolean;
  models: string[];
}

function sliceOf(cfg: RoutingConfig, keys: readonly (keyof RoutingConfig)[]) {
  return Object.fromEntries(keys.map((k) => [k, cfg[k]]));
}

export function RoutingRulesPanel() {
  const [cfg, setCfg] = useState<RoutingConfig | null>(null);
  /** The config as last loaded or saved: what `dirty` is measured against. */
  const [base, setBase] = useState<RoutingConfig | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [modelsSource, setModelsSource] = useState<"live" | "fallback" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  useEffect(() => {
    fetch("/api/routing")
      .then((r) => r.json())
      .then((d: RoutingConfig) => {
        setCfg(d);
        setBase(d);
      });
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        setModels(d.models ?? []);
        setGroups((d.groups ?? []).filter((g: ModelGroup) => g.models.length > 0));
        setModelsSource(d.source ?? null);
      })
      .catch(() => {});
  }, []);

  const save = useCallback(
    async (card: keyof typeof OWNS) => {
      if (!cfg) return;
      setBusy(card);
      setErrors((e) => ({ ...e, [card]: null }));
      try {
        const res = await fetch("/api/routing", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sliceOf(cfg, OWNS[card])),
        });
        if (!res.ok) throw new Error(`gate answered ${res.status}`);
        setBase(await res.json());
      } catch (error) {
        setErrors((e) => ({ ...e, [card]: error instanceof Error ? error.message : String(error) }));
      } finally {
        setBusy(null);
      }
    },
    [cfg],
  );

  const dirty = useMemo(() => {
    const out = {} as Record<keyof typeof OWNS, boolean>;
    for (const card of Object.keys(OWNS) as (keyof typeof OWNS)[]) {
      out[card] =
        !!cfg && !!base && JSON.stringify(sliceOf(cfg, OWNS[card])) !== JSON.stringify(sliceOf(base, OWNS[card]));
    }
    return out;
  }, [cfg, base]);

  function applyPreset(p: Preset) {
    if (!cfg) return;
    setCfg({ ...cfg, preset: p, categories: { ...PRESETS[p].categories }, effort: { ...PRESETS[p].effort } });
  }

  if (!cfg) return null;

  return (
    <div className="grid gap-6 md:grid-cols-2">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <SlidersHorizontal className="size-4" /> Difficulty to model
            </CardTitle>
            <CardDescription>A preset sets all six at once; each row can then be changed on its own.</CardDescription>
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
                    <Select
                      value={cfg.categories[c.key]}
                      onChange={(e) => setCfg({ ...cfg, categories: { ...cfg.categories, [c.key]: e.target.value as Tier } })}
                      className="w-24 capitalize"
                    >
                      {TIERS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                    <Select
                      value={cfg.effort?.[c.key] ?? "default"}
                      onChange={(e) => setCfg({ ...cfg, effort: { ...cfg.effort, [c.key]: e.target.value as Effort } })}
                      className="w-28"
                      title="output_config.effort on adaptive models; thinking budget on Haiku"
                    >
                      {EFFORTS.map((o) => (
                        <option key={o.v} value={o.v}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
          <SaveRow dirty={dirty.difficulty} busy={busy === "difficulty"} error={errors.difficulty} onSave={() => save("difficulty")} />
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Gauge className="size-4" /> How difficulty is decided
            </CardTitle>
            <CardDescription>What grades an ungraded request, and where the size thresholds sit.</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-5">
            <div className="space-y-3 rounded-md border p-2.5">
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
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Route named models too</div>
                  <div className="text-xs text-muted-foreground">
                    Off, a client asking for <code className="font-mono">claude-sonnet-5</code> by name gets exactly that. On, it is graded
                    and sent to the tier below — which is what puts Claude Code on these rules.
                  </div>
                </div>
                {/* The stored flag is the inverse: overrideExplicit true means "pass an explicit id through". */}
                <Switch checked={!cfg.overrideExplicit} onCheckedChange={(v) => setCfg({ ...cfg, overrideExplicit: !v })} />
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
          </CardContent>
          <SaveRow dirty={dirty.decide} busy={busy === "decide"} error={errors.decide} onSave={() => save("decide")} />
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Layers className="size-4" /> Model version per tier
            </CardTitle>
            <CardDescription>
              Which concrete model each tier resolves to — a Claude model, or one your providers serve.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            <div className="flex items-center justify-end">
              {modelsSource && (
                <span className="text-[11px] text-muted-foreground">{modelsSource === "live" ? "from your account" : "known list"}</span>
              )}
            </div>
            <div className="mt-2 grid gap-2">
              {TIERS.map((t) => {
                const current = cfg.tiers[t];
                // A tier may already point at a model this catalogue no longer
                // lists (an endpoint that is down, a retired Claude id). Keep it
                // selectable so saving the form does not silently re-route it.
                const orphan = !models.includes(current);
                return (
                  <div key={t} className="flex items-center gap-2">
                    <span className="w-16 text-sm capitalize">{t}</span>
                    <Select
                      value={current}
                      onChange={(e) => setCfg({ ...cfg, tiers: { ...cfg.tiers, [t]: e.target.value } })}
                      className="flex-1 font-mono text-xs"
                    >
                      {orphan && <option value={current}>{current}</option>}
                      {groups.map((g) => (
                        <optgroup key={g.label} label={g.selfHosted ? `${g.label} (local)` : g.label}>
                          {g.models.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </Select>
                  </div>
                );
              })}
            </div>
          </CardContent>
      <SaveRow dirty={dirty.tiers} busy={busy === "tiers"} error={errors.tiers} onSave={() => save("tiers")} />
      </Card>
    </div>
  );
}
