"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { Save, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface Settings {
  compression: { enabled: boolean; maxBlockChars: number; dedupe: boolean };
  cache: { enabled: boolean; ttlSeconds: number };
  budget: { enabled: boolean; mode: "warn" | "block"; dailyUsd: number; monthlyUsd: number };
  fallback: { enabled: boolean; chains: Record<string, string[]> };
  reasoning: { defaultEffort: "none" | "low" | "medium" | "high" };
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-4 py-2">{children}</div>;
}

export function SettingsPanel() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then(setS);
  }, []);

  async function save() {
    if (!s) return;
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  if (!s) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal className="size-4" /> Gateway settings
        </CardTitle>
        <CardDescription>Compression, caching, budget, fallback, and reasoning.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        <div className="pb-2">
          <Row>
            <div>
              <Label>Context compression</Label>
              <p className="text-xs text-muted-foreground">Trim oversized & duplicate blocks.</p>
            </div>
            <Switch
              checked={s.compression.enabled}
              onCheckedChange={(v) => setS({ ...s, compression: { ...s.compression, enabled: v } })}
            />
          </Row>
          {s.compression.enabled && (
            <Row>
              <Label className="text-xs text-muted-foreground">Max block chars</Label>
              <Input
                type="number"
                className="h-8 w-28"
                value={s.compression.maxBlockChars}
                onChange={(e) =>
                  setS({ ...s, compression: { ...s.compression, maxBlockChars: Number(e.target.value) } })
                }
              />
            </Row>
          )}
        </div>

        <div className="py-2">
          <Row>
            <div>
              <Label>Response cache</Label>
              <p className="text-xs text-muted-foreground">Reuse identical non-stream responses.</p>
            </div>
            <Switch
              checked={s.cache.enabled}
              onCheckedChange={(v) => setS({ ...s, cache: { ...s.cache, enabled: v } })}
            />
          </Row>
          {s.cache.enabled && (
            <Row>
              <Label className="text-xs text-muted-foreground">TTL (seconds)</Label>
              <Input
                type="number"
                className="h-8 w-28"
                value={s.cache.ttlSeconds}
                onChange={(e) => setS({ ...s, cache: { ...s.cache, ttlSeconds: Number(e.target.value) } })}
              />
            </Row>
          )}
        </div>

        <div className="py-2">
          <Row>
            <div>
              <Label>Budget limits</Label>
              <p className="text-xs text-muted-foreground">Warn or block when spend exceeds.</p>
            </div>
            <Switch
              checked={s.budget.enabled}
              onCheckedChange={(v) => setS({ ...s, budget: { ...s.budget, enabled: v } })}
            />
          </Row>
          {s.budget.enabled && (
            <>
              <Row>
                <Label className="text-xs text-muted-foreground">Daily / Monthly (USD)</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    className="h-8 w-24"
                    value={s.budget.dailyUsd}
                    onChange={(e) => setS({ ...s, budget: { ...s.budget, dailyUsd: Number(e.target.value) } })}
                  />
                  <Input
                    type="number"
                    className="h-8 w-24"
                    value={s.budget.monthlyUsd}
                    onChange={(e) => setS({ ...s, budget: { ...s.budget, monthlyUsd: Number(e.target.value) } })}
                  />
                </div>
              </Row>
              <Row>
                <Label className="text-xs text-muted-foreground">When exceeded</Label>
                <select
                  value={s.budget.mode}
                  onChange={(e) => setS({ ...s, budget: { ...s.budget, mode: e.target.value as "warn" | "block" } })}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                >
                  <option value="warn">Warn</option>
                  <option value="block">Block</option>
                </select>
              </Row>
            </>
          )}
        </div>

        <div className="py-2">
          <Row>
            <div>
              <Label>Tier fallback</Label>
              <p className="text-xs text-muted-foreground">On 429/529, drop to a cheaper tier.</p>
            </div>
            <Switch
              checked={s.fallback.enabled}
              onCheckedChange={(v) => setS({ ...s, fallback: { ...s.fallback, enabled: v } })}
            />
          </Row>
        </div>

        <div className="py-2">
          <Row>
            <div>
              <Label>Default reasoning effort</Label>
              <p className="text-xs text-muted-foreground">Extended thinking when unspecified.</p>
            </div>
            <select
              value={s.reasoning.defaultEffort}
              onChange={(e) =>
                setS({ ...s, reasoning: { defaultEffort: e.target.value as Settings["reasoning"]["defaultEffort"] } })
              }
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="none">None</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Row>
        </div>

        <div className="pt-3">
          <Button onClick={save} size="sm">
            <Save /> {saved ? "Saved" : "Save settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
