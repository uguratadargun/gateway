"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { Coins, Gauge, Layers, Route, Save } from "lucide-react";

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
  reasoning: { defaultEffort: "default" | "low" | "medium" | "high" | "xhigh" | "max" };
  promptCache: { enabled: boolean; ttl: "5m" | "1h" };
  concurrency: { maxInFlight: number; queueTimeoutMs: number };
  throttle: { enabled: boolean; downgradeAt: number; blockAt: number };
  retry: { maxRetries: number; maxRateLimitWaitMs: number };
  routingPrecision: { countTokens: boolean };
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-4 py-2">{children}</div>;
}

function Head({ label, hint }: { label: string; hint: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Group({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4" /> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y pt-0">{children}</CardContent>
    </Card>
  );
}

const selectCls = "h-8 rounded-md border border-input bg-transparent px-2 text-sm";

/**
 * Everything here writes one settings document, so it saves once — but the
 * knobs answer four unrelated questions (what is cached, what happens as the
 * quota fills, what happens when upstream fails, how precise routing is), and
 * stacking them in a single column made the answer to any one of them hard to
 * find. One card per question; the save stays with the section.
 */
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
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Gateway settings</h2>
          <p className="text-sm text-muted-foreground">
            Quota protection, caching, budget, fallback, and reasoning.
          </p>
        </div>
        <Button onClick={save} size="sm">
          <Save /> {saved ? "Saved" : "Save settings"}
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Group icon={Layers} title="Caching" description="What gets reused instead of re-sent.">
          <div className="pb-2">
            <Row>
              <Head label="Prompt caching" hint="Auto cache_control breakpoints — cached reads bill at 10%." />
              <Switch
                checked={s.promptCache.enabled}
                onCheckedChange={(v) => setS({ ...s, promptCache: { ...s.promptCache, enabled: v } })}
              />
            </Row>
            {s.promptCache.enabled && (
              <Row>
                <Label className="text-xs text-muted-foreground">Cache TTL</Label>
                <select
                  value={s.promptCache.ttl}
                  onChange={(e) => setS({ ...s, promptCache: { ...s.promptCache, ttl: e.target.value as "5m" | "1h" } })}
                  className={selectCls}
                  title="5m: writes 1.25×, refreshed free while active. 1h: writes 2×, for sessions with long pauses."
                >
                  <option value="5m">5 min (active sessions)</option>
                  <option value="1h">1 hour (long pauses)</option>
                </select>
              </Row>
            )}
          </div>

          <div className="py-2">
            <Row>
              <Head label="Response cache" hint="Reuse identical deterministic (temp 0) replies." />
              <Switch checked={s.cache.enabled} onCheckedChange={(v) => setS({ ...s, cache: { ...s.cache, enabled: v } })} />
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

          <div className="pt-2">
            <Row>
              <Head label="Context compression" hint="Trim oversized & duplicate blocks." />
              <Switch
                checked={s.compression.enabled}
                onCheckedChange={(v) => setS({ ...s, compression: { ...s.compression, enabled: v } })}
              />
            </Row>
          </div>
        </Group>

        <Group icon={Gauge} title="Quota protection" description="What happens as the window and the budget fill.">
          <div className="pb-2">
            <Row>
              <Head label="Rate-limit throttle" hint="Downgrade tier, then block, as the 5h window fills." />
              <Switch
                checked={s.throttle.enabled}
                onCheckedChange={(v) => setS({ ...s, throttle: { ...s.throttle, enabled: v } })}
              />
            </Row>
            {s.throttle.enabled && (
              <Row>
                <Label className="text-xs text-muted-foreground">Downgrade at / block at (%)</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    className="h-8 w-20"
                    value={Math.round(s.throttle.downgradeAt * 100)}
                    onChange={(e) => setS({ ...s, throttle: { ...s.throttle, downgradeAt: Number(e.target.value) / 100 } })}
                  />
                  <Input
                    type="number"
                    className="h-8 w-20"
                    value={Math.round(s.throttle.blockAt * 100)}
                    onChange={(e) => setS({ ...s, throttle: { ...s.throttle, blockAt: Number(e.target.value) / 100 } })}
                  />
                </div>
              </Row>
            )}
          </div>

          <div className="pt-2">
            <Row>
              <Head label="Budget limits" hint="Warn or block when spend exceeds." />
              <Switch checked={s.budget.enabled} onCheckedChange={(v) => setS({ ...s, budget: { ...s.budget, enabled: v } })} />
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
                    className={selectCls}
                  >
                    <option value="warn">Warn</option>
                    <option value="block">Block</option>
                  </select>
                </Row>
              </>
            )}
          </div>
        </Group>

        <Group icon={Coins} title="Reliability" description="How much is in flight, and what happens when upstream refuses.">
          <div className="pb-2">
            <Row>
              <Head label="Concurrency limit" hint="Max simultaneous upstream requests; the rest queue." />
              <Input
                type="number"
                className="h-8 w-20"
                value={s.concurrency.maxInFlight}
                onChange={(e) => setS({ ...s, concurrency: { ...s.concurrency, maxInFlight: Number(e.target.value) } })}
              />
            </Row>
          </div>
          <div className="py-2">
            <Row>
              <Head label="Retries" hint="Backoff retries on network/5xx/overloaded." />
              <Input
                type="number"
                className="h-8 w-20"
                value={s.retry.maxRetries}
                onChange={(e) => setS({ ...s, retry: { ...s.retry, maxRetries: Number(e.target.value) } })}
              />
            </Row>
          </div>
          <div className="pt-2">
            <Row>
              <Head label="Tier fallback" hint="On 429/529, drop to a cheaper tier." />
              <Switch
                checked={s.fallback.enabled}
                onCheckedChange={(v) => setS({ ...s, fallback: { ...s.fallback, enabled: v } })}
              />
            </Row>
          </div>
        </Group>

        <Group icon={Route} title="Routing precision" description="How carefully a request is sized and how hard it thinks.">
          <div className="pb-2">
            <Row>
              <Head label="Exact token routing" hint="Use count_tokens for thresholds (one extra call)." />
              <Switch
                checked={s.routingPrecision.countTokens}
                onCheckedChange={(v) => setS({ ...s, routingPrecision: { countTokens: v } })}
              />
            </Row>
          </div>
          <div className="pt-2">
            <Row>
              <Head label="Fallback reasoning effort" hint="Used when routing rules don't set one." />
              <select
                value={s.reasoning.defaultEffort}
                onChange={(e) =>
                  setS({ ...s, reasoning: { defaultEffort: e.target.value as Settings["reasoning"]["defaultEffort"] } })
                }
                className={selectCls}
              >
                <option value="default">API default (high)</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">xhigh</option>
                <option value="max">Max</option>
              </select>
            </Row>
          </div>
        </Group>
      </div>
    </section>
  );
}
