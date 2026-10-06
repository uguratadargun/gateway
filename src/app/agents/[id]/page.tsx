"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Save, Trash2 } from "lucide-react";

import { formFromAgent, frontmatterFrom, type AgentEditorOptions, type AgentForm } from "@/agents/form";
import { AgentEditor, PromptEditor } from "@/components/agent-editor";
import { useTeamScope, withTeam } from "@/components/team-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

/**
 * One agent. The form owns the frontmatter and a textarea owns the prompt;
 * Markdown mode is still there for the file itself, because these are files
 * and someone will want to paste one.
 */

interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  model: string;
  effort?: string;
  executor?: string;
  inputs: string[];
  output: { type: string; schema?: Record<string, string> };
  tools: string[];
  timeoutMs?: number;
  maxTokens?: number;
  maxToolIterations?: number;
  prompt: string;
  sourcePath: string;
  updatedAt: number;
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [options, setOptions] = useState<AgentEditorOptions | null>(null);
  const [form, setForm] = useState<AgentForm | null>(null);
  const [prompt, setPrompt] = useState("");
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  /** What the form looked like when it was last in sync with disk. */
  const [baseline, setBaseline] = useState("");
  const [mode, setMode] = useState<"form" | "markdown">("form");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which team's copy of this id. It rides in the URL from the list page, so a
  // link to another team's agent opens that team's agent.
  const { team, ready } = useTeamScope();

  const settle = useCallback((a: AgentDetail, src: string) => {
    const next = formFromAgent(a);
    setAgent(a);
    setForm(next);
    setPrompt(a.prompt);
    setSource(src);
    setSavedSource(src);
    setBaseline(JSON.stringify({ form: next, prompt: a.prompt }));
  }, []);

  useEffect(() => {
    if (!ready) return;
    (async () => {
      const r = await fetch(withTeam(`/api/agents/${id}`, team));
      const data = await r.json();
      if (!r.ok) {
        setError(data.error);
        return;
      }
      setOptions(data.options);
      settle(data.agent, data.source);
    })();
  }, [id, settle, team, ready]);

  const dirty = useMemo(() => {
    if (mode === "markdown") return source !== savedSource;
    if (!form) return false;
    return JSON.stringify({ form, prompt }) !== baseline;
  }, [mode, source, savedSource, form, prompt, baseline]);

  const save = useCallback(async () => {
    if (!form) return;
    setBusy(true);
    const body = mode === "markdown" ? { source } : { frontmatter: frontmatterFrom(form), prompt };
    const r = await fetch(withTeam(`/api/agents/${id}`, team), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    setBusy(false);
    if (!r.ok) {
      setError(data.error ?? "invalid agent");
      return;
    }
    setError(null);
    // Settled from what the server actually parsed, not from what was typed:
    // an empty input row or a defaulted field is normalized away here rather
    // than leaving the page one save behind the file.
    settle(data.agent, data.source);
  }, [id, mode, source, form, prompt, settle]);

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
    await fetch(withTeam(`/api/agents/${id}`, team), { method: "DELETE" });
    router.push(withTeam("/agents", team));
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 px-6 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={withTeam("/agents", team)}>
            <Button variant="ghost" size="icon" aria-label="Back">
              <ArrowLeft />
            </Button>
          </Link>
          <div>
            <h1 className="font-mono text-lg font-semibold">{id}</h1>
            <p className="text-xs text-muted-foreground">{agent?.sourcePath ?? "…"}</p>
          </div>
          {form && (
            <div className="flex items-center gap-1">
              <Badge variant="secondary" className="font-mono text-[10px]">
                {form.model}
              </Badge>
              {form.effort && (
                <Badge variant="outline" className="text-[10px]">
                  {form.effort}
                </Badge>
              )}
              <Badge variant="outline" className="font-mono text-[10px]">
                {form.executor}
              </Badge>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Switching modes needs the file and the form to agree, and only a
              save can make them: the browser never assembles the YAML. */}
          <div className="flex rounded-md border p-0.5" title={dirty ? "Save first — the two views agree on disk" : undefined}>
            {(["form", "markdown"] as const).map((m) => (
              <Button
                key={m}
                variant={mode === m ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={dirty && mode !== m}
                onClick={() => setMode(m)}
              >
                {m === "form" ? "Form" : "Markdown"}
              </Button>
            ))}
          </div>
          <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete">
            <Trash2 />
          </Button>
          <Button onClick={save} disabled={busy || !dirty}>
            <Save /> {dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </header>

      {error && <Card className="border-destructive/50 p-3 text-sm text-destructive">{error}</Card>}

      {!form || !options ? (
        <Card className="p-4 text-sm text-muted-foreground">Loading…</Card>
      ) : mode === "markdown" ? (
        <div className="space-y-2">
          <Textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            className="h-[70vh] resize-none font-mono text-xs leading-relaxed"
          />
          <p className="text-[11px] text-muted-foreground">
            The file as it is on disk. Invalid definitions are rejected on save and never written. ⌘S saves.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Prompt</div>
            <PromptEditor value={prompt} onChange={setPrompt} />
            <p className="text-[11px] text-muted-foreground">
              Two placeholder forms and nothing else: <span className="font-mono">{"{{input.key}}"}</span> for the run
              input, <span className="font-mono">{"{{inputs.node.field}}"}</span> for anything declared on the right.
              An undeclared one is refused on save. ⌘S saves.
            </p>
          </div>
          <div className="max-h-[calc(70vh+3rem)] overflow-y-auto pr-1">
            <AgentEditor form={form} options={options} onChange={(patch) => setForm({ ...form, ...patch })} />
          </div>
        </div>
      )}
    </main>
  );
}
