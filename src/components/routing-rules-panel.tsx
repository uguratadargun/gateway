"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Layers } from "lucide-react";

import { SaveRow } from "@/components/save-row";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";

type Tier = "haiku" | "sonnet" | "opus" | "fable";

interface RoutingConfig {
  tiers: Record<Tier, string>;
}

/**
 * What each card owns. A card saves these keys and nothing else.
 */
const OWNS = {
  tiers: ["tiers"],
} as const satisfies Record<string, readonly (keyof RoutingConfig)[]>;

const TIERS: Tier[] = ["haiku", "sonnet", "opus", "fable"];

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

  if (!cfg) return null;

  return (
    <div className="grid gap-6">
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
