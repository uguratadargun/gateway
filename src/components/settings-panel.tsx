"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Puzzle } from "lucide-react";

import { SaveRow } from "@/components/save-row";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

interface Settings {
  memory: {
    enabled: boolean;
    model: string;
    embeddings: { provider: string; model: string };
    consolidateEvery: number;
    indexEveryMinutes: number;
    recordMerges: boolean;
  };
  plugin: { source: string };
}

/** The memory section as an older server may leave it: every field with a default. */
function memoryOf(s: Settings): Settings["memory"] {
  return {
    enabled: s.memory?.enabled ?? true,
    model: s.memory?.model ?? "",
    embeddings: { provider: s.memory?.embeddings?.provider ?? "", model: s.memory?.embeddings?.model ?? "" },
    consolidateEvery: s.memory?.consolidateEvery ?? 5,
    indexEveryMinutes: s.memory?.indexEveryMinutes ?? 15,
    recordMerges: s.memory?.recordMerges ?? false,
  };
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
  dirty,
  busy,
  error,
  onSave,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  dirty: boolean;
  busy: boolean;
  error: string | null | undefined;
  onSave: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="size-4" /> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 divide-y pt-0">{children}</CardContent>
      <SaveRow dirty={dirty} busy={busy} error={error} onSave={onSave} />
    </Card>
  );
}

/**
 * What each card owns. A card PUTs these keys alone — `saveSettings` merges
 * group by group — so saving one card cannot write back a stale copy of
 * another's.
 */
const OWNS = {
  memory: ["memory"],
  plugin: ["plugin"],
} as const satisfies Record<string, readonly (keyof Settings)[]>;

type GroupKey = keyof typeof OWNS;

/** The card's own keys, with memory normalised the way the server expects. */
function sliceOf(s: Settings, keys: readonly (keyof Settings)[]) {
  return Object.fromEntries(keys.map((k) => [k, k === "memory" ? memoryOf(s) : s[k]]));
}

/**
 * The knobs here answer two unrelated questions (what memory records, and
 * where the plugin comes from), so there is one card per question and each
 * saves the keys it shows. They share one settings document, but the server
 * merges group by group, so a narrow write is the safe one.
 */
export function SettingsPanel() {
  const [s, setS] = useState<Settings | null>(null);
  /** Settings as last loaded or saved: what `dirty` is measured against. */
  const [base, setBase] = useState<Settings | null>(null);
  /** The configured providers, for the embeddings picker. */
  const [providers, setProviders] = useState<Array<{ name: string; label: string; kind: string }>>([]);
  const [busy, setBusy] = useState<GroupKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<GroupKey, string | null>>>({});

  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((d) => setProviders((d.providers ?? []).filter((p: { kind: string }) => p.kind === "openai-compat")))
      .catch(() => {});
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: Settings) => {
        setS(d);
        setBase(d);
      });
  }, []);

  const save = useCallback(
    async (card: GroupKey) => {
      if (!s) return;
      setBusy(card);
      setErrors((e) => ({ ...e, [card]: null }));
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sliceOf(s, OWNS[card])),
        });
        if (!res.ok) throw new Error(`gate answered ${res.status}`);
        setBase(await res.json());
      } catch (error) {
        setErrors((e) => ({ ...e, [card]: error instanceof Error ? error.message : String(error) }));
      } finally {
        setBusy(null);
      }
    },
    [s],
  );

  const dirty = useMemo(() => {
    const out = {} as Record<GroupKey, boolean>;
    for (const card of Object.keys(OWNS) as GroupKey[]) {
      out[card] =
        !!s && !!base && JSON.stringify(sliceOf(s, OWNS[card])) !== JSON.stringify(sliceOf(base, OWNS[card]));
    }
    return out;
  }, [s, base]);

  if (!s) return null;

  const groupProps = (card: GroupKey) => ({
    dirty: dirty[card],
    busy: busy === card,
    error: errors[card],
    onSave: () => save(card),
  });

  return (
    <div className="grid gap-6 md:grid-cols-2">
        <Group icon={BookOpen} title="Memory" description="After a run, the recorder writes what it decided — why, how, where — for the runs after it." {...groupProps("memory")}>
          <div className="pb-2">
            <Row>
              <Head label="Record runs" hint="Off, runs still finish; nothing is written to memory and the recall node finds nothing new." />
              <Switch checked={s.memory?.enabled ?? true} onCheckedChange={(v) => setS({ ...s, memory: { ...memoryOf(s), enabled: v } })} />
            </Row>
          </div>
          <div className="py-2">
            <Row>
              <Head
                label="Recorder model"
                hint="provider:<name>/<model>, from the providers above — this server holds no Claude account. It reads a run and writes a page. Empty, finished runs wait until one is set."
              />
              <Input
                className="w-56"
                placeholder="provider:vllm/…"
                value={s.memory?.model ?? ""}
                onChange={(e) => setS({ ...s, memory: { ...memoryOf(s), model: e.target.value } })}
              />
            </Row>
          </div>
          <div className="py-2">
            <Row>
              <Head
                label="Embeddings"
                hint="Semantic search, from a configured OpenAI-compatible provider that serves an embedding model (Ollama, vLLM, OpenAI). Empty means words alone."
              />
              <div className="flex gap-2">
                <Select
                  value={s.memory?.embeddings?.provider ?? ""}
                  onChange={(e) => setS({ ...s, memory: { ...memoryOf(s), embeddings: { ...memoryOf(s).embeddings, provider: e.target.value } } })}
                >
                  <option value="">off</option>
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.label}
                    </option>
                  ))}
                </Select>
                <Input
                  className="w-48"
                  placeholder="embedding model"
                  value={s.memory?.embeddings?.model ?? ""}
                  onChange={(e) => setS({ ...s, memory: { ...memoryOf(s), embeddings: { ...memoryOf(s).embeddings, model: e.target.value } } })}
                />
              </div>
            </Row>
          </div>
          <div className="pt-2">
            <Row>
              <Head label="Consolidate after" hint="New decisions on a feature before a team's summary of it is rewritten from all of them. 0 leaves it to the button." />
              <Input
                type="number"
                className="w-24"
                value={s.memory?.consolidateEvery ?? 5}
                onChange={(e) => setS({ ...s, memory: { ...memoryOf(s), consolidateEvery: Number(e.target.value) } })}
              />
            </Row>
          </div>
          <div className="pt-2">
            <Row>
              <Head
                label="Read repositories every"
                hint="Minutes between reads of every connected repository's base branch: its design docs, decision records and specs, which merges landed, and which recorded decisions describe files that are gone. Code, not a model. 0 leaves it to the button on Memory."
              />
              <Input
                type="number"
                className="w-24"
                value={s.memory?.indexEveryMinutes ?? 15}
                onChange={(e) => setS({ ...s, memory: { ...memoryOf(s), indexEveryMinutes: Number(e.target.value) } })}
              />
            </Row>
          </div>
          <div className="pt-2">
            <Row>
              <Head
                label="Record merges made without gate"
                hint="A merge on a base branch that no gate run made is recorded the way a run is — one model call per merge. Off, the repository's documents are still read for nothing."
              />
              <Switch
                checked={s.memory?.recordMerges ?? false}
                onCheckedChange={(v) => setS({ ...s, memory: { ...memoryOf(s), recordMerges: v } })}
              />
            </Row>
          </div>
        </Group>

        <Group icon={Puzzle} title="Plugin" description="Where a new machine fetches the gate plugin from." {...groupProps("plugin")}>
          <div className="pb-2">
            <Row>
              <Head
                label="Marketplace source"
                hint="What the Team page tells people to /plugin marketplace add: a GitHub owner/repo, or a git URL of a mirror of this repository."
              />
              <Input
                value={s.plugin.source}
                onChange={(e) => setS({ ...s, plugin: { source: e.target.value } })}
                placeholder="uguratadargun/gateway"
                className="h-8 w-72 font-mono text-xs"
                spellCheck={false}
              />
            </Row>
          </div>
      </Group>
    </div>
  );
}
