"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, ExternalLink, Plug, Timer, Trash2, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Strategy = "fill-first" | "round-robin" | "least-used" | "p2c" | "random";

interface Account {
  id: string;
  label: string;
  email: string | null;
  organization: string | null;
  planTier: string | null;
  enabled: boolean;
  priority: number;
  lastUsedAt: number | null;
  cooldownUntil: number | null;
  lastError: string | null;
  connectedAt: number;
  coolingDown: boolean;
  quotaBlockedWindow: string | null;
  /** 5h window used, 0..1. Null while no window reading is known yet. */
  utilization: number | null;
  /** Every window this account reports, named and ordered by the server. */
  windows: QuotaWindow[];
  quota: { plan?: string | null; source?: string; error?: string | null } | null;
}

interface QuotaWindow {
  name: string;
  /** "session limit" · "weekly limit" · "Fable limit" — Claude's own words. */
  label: string;
  /** Percent of the window still free. */
  remaining: number;
  resetsAt: string | null;
}

interface PoolConfig {
  strategy: Strategy;
  stickyRoundRobinLimit: number;
  quotaMinRemainingPercent: number;
  quotaRefreshMinutes: number;
}

const STRATEGIES: { v: Strategy; label: string; hint: string }[] = [
  { v: "fill-first", label: "Fill first", hint: "Stay on the top account until its window runs out. Keeps one prompt cache hot." },
  { v: "round-robin", label: "Round robin", hint: "Rotate after a run of requests, so every account warms up." },
  { v: "least-used", label: "Least used", hint: "Always the account idle longest. Spreads the load evenly." },
  { v: "p2c", label: "Power of two", hint: "Pick two at random, use the healthier. Cheap load balancing." },
  { v: "random", label: "Random", hint: "Uniformly random among available accounts." },
];

const selectCls = "h-8 rounded-md border border-input bg-transparent px-2 text-sm";

function relative(ms: number | null): string {
  if (!ms) return "never";
  const delta = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(delta);
  // Days matter here: a weekly window resets three days out, and "in 83h" is
  // not a length of time anyone reads at a glance.
  const unit =
    abs < 60
      ? [abs, "s"]
      : abs < 3600
        ? [Math.round(abs / 60), "m"]
        : abs < 86_400
          ? [Math.round(abs / 3600), "h"]
          : [Math.round(abs / 86_400), "d"];
  return delta < 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
}

/** Green while there is room, amber as it tightens, red at the end. */
function barColor(remaining: number): string {
  if (remaining <= 10) return "bg-destructive";
  if (remaining <= 30) return "bg-amber-500";
  return "bg-emerald-500";
}

export function AccountsPanel() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [pool, setPool] = useState<PoolConfig | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/accounts");
    const data = await res.json();
    setAccounts(data.accounts ?? []);
    setPool(data.strategy ?? null);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function startLogin() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/start", { method: "POST" });
      const data = await res.json();
      setAuthUrl(data.authUrl);
      window.open(data.authUrl, "_blank", "noopener");
    } finally {
      setBusy(false);
    }
  }

  async function completeLogin() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), ...(label.trim() ? { label: label.trim() } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }
      setAuthUrl(null);
      setCode("");
      setLabel("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await refresh();
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Disconnect "${name}"? Its stored tokens are deleted.`)) return;
    await fetch(`/api/accounts/${id}`, { method: "DELETE" });
    await refresh();
  }

  /** Swap this account's priority with its neighbour's, so order is explicit. */
  async function move(index: number, direction: -1 | 1) {
    if (!accounts) return;
    const a = accounts[index];
    const b = accounts[index + direction];
    if (!a || !b) return;
    await patch(a.id, { priority: b.priority });
    await patch(b.id, { priority: a.priority });
  }

  async function savePool(next: Partial<PoolConfig>) {
    if (!pool) return;
    const merged = { ...pool, ...next };
    setPool(merged);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountPool: merged }),
    });
  }

  if (!accounts) return null;

  const addForm = (
    <div className="space-y-3">
      {!authUrl ? (
        <Button onClick={startLogin} disabled={busy} size={accounts.length ? "sm" : "default"} variant={accounts.length ? "outline" : "default"}>
          <ExternalLink /> {accounts.length ? "Add another account" : "Start Claude login"}
        </Button>
      ) : (
        <div className="space-y-3 rounded-md border p-3">
          <a
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary underline underline-offset-4"
          >
            <ExternalLink className="size-3.5" /> Re-open authorization page
          </a>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="code">Authorization code</Label>
              <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="label">Name (optional)</Label>
              <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="work" autoComplete="off" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={completeLogin} disabled={busy || !code.trim()} size="sm">
              Connect
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAuthUrl(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );

  if (accounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plug /> Connect your Claude account
          </CardTitle>
          <CardDescription>
            Uses the same Claude Code OAuth login (PKCE). Open the page, approve, then paste the code
            Anthropic shows you. Connect more than one and gate rotates between them.
          </CardDescription>
        </CardHeader>
        <CardContent>{addForm}</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            {accounts.length > 1 ? <Users className="text-emerald-500" /> : <CheckCircle2 className="text-emerald-500" />}
            {accounts.length === 1 ? "Account connected" : `${accounts.length} accounts connected`}
          </CardTitle>
          <CardDescription>
            {accounts.length === 1
              ? "Tokens refresh on their own. Add a second account to keep serving when this one hits its window."
              : "A rate-limited account cools down and the next one takes over, before any tier is downgraded."}
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          {accounts.map((a, i) => {
            return (
              <div key={a.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{a.label}</span>
                      {a.coolingDown ? (
                        <Badge variant="destructive" className="gap-1">
                          <Timer className="size-3" /> cooling down {relative(a.cooldownUntil)}
                        </Badge>
                      ) : a.quotaBlockedWindow ? (
                        <Badge variant="destructive">
                          {a.windows?.find((w) => w.name === a.quotaBlockedWindow)?.label ?? a.quotaBlockedWindow} exhausted
                        </Badge>
                      ) : a.enabled ? (
                        <Badge variant="success">ready</Badge>
                      ) : (
                        <Badge variant="secondary">paused</Badge>
                      )}
                      {(a.planTier || a.quota?.plan) && <Badge variant="outline">{a.planTier ?? a.quota?.plan}</Badge>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {a.email ?? "signed in"}
                      {a.organization ? ` · ${a.organization}` : ""} · last used {relative(a.lastUsedAt)}
                    </div>
                    {a.lastError && <div className="mt-1 truncate text-xs text-destructive">{a.lastError}</div>}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="icon" disabled={i === 0} onClick={() => move(i, -1)} title="Prefer earlier">
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" disabled={i === accounts.length - 1} onClick={() => move(i, 1)} title="Prefer later">
                      <ArrowDown className="size-4" />
                    </Button>
                    <span title="Serve traffic">
                      <Switch checked={a.enabled} onCheckedChange={(v) => patch(a.id, { enabled: v })} />
                    </span>
                    <Button variant="ghost" size="icon" onClick={() => remove(a.id, a.label)} title="Disconnect">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="mt-2 space-y-1">
                  {(a.windows ?? []).length === 0 ? (
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" />
                      <span
                        className="w-40 shrink-0 text-right text-[11px] text-muted-foreground"
                        title={a.quota?.error ?? "Claude reports its windows once this account is polled or serves a request."}
                      >
                        {a.quota?.error ? "windows unavailable" : "windows pending"}
                      </span>
                    </div>
                  ) : (
                    a.windows.map((w) => (
                      <div key={w.name} className="flex items-center gap-2">
                        <span className="w-24 shrink-0 truncate text-[11px] text-muted-foreground" title={w.name}>
                          {w.label}
                        </span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full transition-all ${barColor(w.remaining)}`}
                            style={{ width: `${Math.max(0, Math.min(100, 100 - w.remaining))}%` }}
                          />
                        </div>
                        <span className="w-32 shrink-0 text-right text-[11px] text-muted-foreground">
                          {Math.round(w.remaining)}% left
                          {w.resetsAt ? ` · resets ${relative(Date.parse(w.resetsAt))}` : ""}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {pool && accounts.length > 1 && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Rotation</div>
                <div className="text-xs text-muted-foreground">
                  {STRATEGIES.find((s) => s.v === pool.strategy)?.hint}
                </div>
              </div>
              <select
                value={pool.strategy}
                onChange={(e) => savePool({ strategy: e.target.value as Strategy })}
                className={`${selectCls} w-36`}
              >
                {STRATEGIES.map((s) => (
                  <option key={s.v} value={s.v}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {pool.strategy === "round-robin" && (
                <div>
                  <Label className="text-xs text-muted-foreground">Requests before rotating</Label>
                  <Input
                    type="number"
                    min={1}
                    className="mt-1 h-8"
                    value={pool.stickyRoundRobinLimit}
                    onChange={(e) => savePool({ stickyRoundRobinLimit: Math.max(1, Number(e.target.value)) })}
                  />
                </div>
              )}
              <div>
                <Label className="text-xs text-muted-foreground">Skip below % window left (0 = off)</Label>
                <Input
                  type="number"
                  min={0}
                  max={99}
                  className="mt-1 h-8"
                  value={pool.quotaMinRemainingPercent}
                  onChange={(e) =>
                    savePool({ quotaMinRemainingPercent: Math.min(99, Math.max(0, Number(e.target.value))) })
                  }
                />
              </div>
            </div>
          </div>
        )}

        {addForm}
      </CardContent>
    </Card>
  );
}
