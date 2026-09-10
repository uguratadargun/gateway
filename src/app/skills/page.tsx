"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DownloadCloud, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TeamPicker, useTeamScope, withTeam } from "@/components/team-picker";
import { cn } from "@/lib/utils";

/**
 * The skill library, and the libraries it can be filled from.
 *
 * One page and not two, because the two halves are one decision: what a team's
 * agents can be told to work by, and where that came from. Importing is
 * deliberate and shown as such — a skill's state against upstream is on the
 * row before you press anything, and the one state that matters most,
 * "somebody changed this here", is the one an update would quietly undo.
 */

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  resources: string[];
  updatedAt: number;
  origin: { sourceId: string; sourceSkill: string; commit: string | null; importedAt: number } | null;
}

type ImportState = "new" | "current" | "outdated" | "edited";

interface SourceSkill {
  sourceSkill: string;
  id: string;
  name: string;
  description: string;
  state: ImportState;
  error?: string;
}

interface Source {
  id: string;
  name: string;
  url: string;
  ref: string | null;
  subdir: string;
  prefix: string;
  headSha: string | null;
  pinnedSha: string | null;
  status: "new" | "syncing" | "ready" | "failed";
  lastSyncAt: number | null;
  lastSyncLog: string | null;
  skills: SourceSkill[];
}

const STATE: Record<ImportState, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  new: { label: "not imported", variant: "outline" },
  current: { label: "up to date", variant: "secondary" },
  outdated: { label: "update available", variant: "default" },
  edited: { label: "edited here", variant: "destructive" },
};

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [inherited, setInherited] = useState<SkillSummary[]>([]);
  const [errors, setErrors] = useState<Array<{ id: string; message: string }>>([]);
  /** What the shipped agents follow and this team has not imported. */
  const [missing, setMissing] = useState<Array<{ id: string; source: string; sourceSkill: string }>>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ id: "", name: "", url: "", ref: "", subdir: "skills", prefix: "" });
  const { team, setTeam, teams, ready } = useTeamScope();

  const load = useCallback(async () => {
    const [lib, src] = await Promise.all([
      fetch(withTeam("/api/skills", team)).then((r) => r.json()),
      fetch(withTeam("/api/skill-sources", team)).then((r) => r.json()),
    ]);
    setSkills(lib.skills ?? []);
    setInherited(lib.inherited ?? []);
    setErrors(lib.errors ?? []);
    setMissing(lib.missingForDefaults ?? []);
    setSources(src.sources ?? []);
  }, [team]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  async function sync(id: string) {
    setBusy(`sync:${id}`);
    setError(null);
    const r = await fetch(withTeam(`/api/skill-sources/${id}/sync`, team), { method: "POST" });
    const data = await r.json();
    setBusy(null);
    if (!r.ok) {
      setError(data.error ?? "sync failed");
      return;
    }
    if (data.source.status === "failed") setError(data.source.lastSyncLog ?? "sync failed");
    setOpen(id);
    await load();
  }

  /**
   * Holds a library at the commit it is on, or lets it follow the remote
   * again. The agents' prompts are written against the text these skills
   * have today; a pin is what keeps a Sync from changing that underneath
   * them.
   */
  async function pin(source: Source, sha: string | null) {
    setBusy(`pin:${source.id}`);
    setError(null);
    const r = await fetch(withTeam(`/api/skill-sources/${source.id}`, team), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinnedSha: sha }),
    });
    const data = await r.json();
    setBusy(null);
    if (!r.ok) {
      setError(data.error ?? "could not change the pin");
      return;
    }
    setNote(sha ? `${source.name} pinned to ${sha.slice(0, 12)} — Sync keeps it there until you unpin` : `${source.name} follows the remote again from the next Sync`);
    await load();
  }

  /**
   * Imports exactly what the shipped agents need, from one button.
   *
   * The alternative is a person reading a run that failed on
   * "declares skill X, which is not in this team's skill library", finding
   * this page, finding the source, syncing it and picking seven names out of
   * fourteen. The list is known; the button is the honest shape.
   */
  async function importForDefaults() {
    const source = missing[0]?.source;
    if (!source) return;
    setBusy("defaults");
    setError(null);
    try {
      // The source has to have been fetched before anything can be copied out
      // of it, and on a fresh install it never has been.
      await fetch(withTeam(`/api/skill-sources/${source}/sync`, team), { method: "POST" });
      const r = await fetch(withTeam(`/api/skill-sources/${source}/import`, team), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skills: missing.map((m) => m.sourceSkill) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "import failed");
      setNote(`Imported ${data.imported.length} skill(s) the default agents follow`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  }

  /** Everything selected in this source, imported in one call. */
  async function importPicked(source: Source, replace: boolean) {
    const wanted = source.skills.filter((s) => picked.has(`${source.id}:${s.sourceSkill}`)).map((s) => s.sourceSkill);
    if (!wanted.length) return;
    setBusy(`import:${source.id}`);
    setError(null);
    const r = await fetch(withTeam(`/api/skill-sources/${source.id}/import`, team), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: wanted, replace }),
    });
    const data = await r.json();
    setBusy(null);
    if (!r.ok) {
      setError(data.error ?? "import failed");
      return;
    }
    setPicked(new Set());
    setNote(
      `Imported ${data.imported.length}` +
        (data.skipped.length ? `, skipped ${data.skipped.map((s: { id: string; reason: string }) => `${s.id} (${s.reason})`).join("; ")}` : ""),
    );
    await load();
  }

  async function addSource() {
    setBusy("add");
    setError(null);
    const r = await fetch(withTeam("/api/skill-sources", team), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft, ref: draft.ref.trim() || undefined }),
    });
    const data = await r.json();
    setBusy(null);
    if (!r.ok) {
      setError(data.error ?? "could not add that source");
      return;
    }
    setAdding(false);
    setDraft({ id: "", name: "", url: "", ref: "", subdir: "skills", prefix: "" });
    await load();
  }

  async function forgetSource(source: Source) {
    if (!confirm(`Forget "${source.name}" and delete gate's clone? Skills already imported stay where they are.`)) return;
    await fetch(withTeam(`/api/skill-sources/${source.id}`, team), { method: "DELETE" });
    await load();
  }

  async function removeSkill(id: string) {
    if (!confirm(`Delete skill "${id}"? Agents naming it will stop saving until they are changed.`)) return;
    await fetch(withTeam(`/api/skills/${id}`, team), { method: "DELETE" });
    await load();
  }

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-6 py-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Skills</h1>
          <p className="text-xs text-muted-foreground">
            How an agent works, as a file it can be told to follow. Assign them in the agent editor.
          </p>
        </div>
        <TeamPicker team={team} teams={teams} onChange={setTeam} />
      </header>

      {error && <Card className="border-destructive/50 p-3 text-xs text-destructive">{error}</Card>}

      {missing.length > 0 && (
        <Card className="flex flex-wrap items-center gap-3 border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <span>
            The shipped super-* agents (dev-super) follow {missing.length} skill{missing.length > 1 ? "s" : ""} this team does not
            have: <span className="font-mono">{missing.map((m) => m.sourceSkill).join(", ")}</span>. dev and dev-quick need
            none; a dev-super run stops at the first node that needs one.
          </span>
          <Button size="sm" className="ml-auto" disabled={busy !== null} onClick={importForDefaults}>
            {busy === "defaults" ? <Loader2 className="animate-spin" /> : <DownloadCloud />} Import them
          </Button>
        </Card>
      )}
      {note && <Card className="p-3 text-xs text-muted-foreground">{note}</Card>}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sources</h2>
          <Button variant="ghost" size="sm" onClick={() => setAdding(!adding)}>
            <Plus /> Add source
          </Button>
        </div>

        {adding && (
          <Card className="grid gap-2 p-3 sm:grid-cols-2">
            <Input placeholder="id (e.g. house-skills)" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} className="h-8 text-xs" />
            <Input placeholder="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="h-8 text-xs" />
            <Input placeholder="git URL" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} className="h-8 font-mono text-xs sm:col-span-2" />
            <Input placeholder="ref (blank = default branch)" value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} className="h-8 font-mono text-xs" />
            <Input placeholder="subdir (skills)" value={draft.subdir} onChange={(e) => setDraft({ ...draft, subdir: e.target.value })} className="h-8 font-mono text-xs" />
            <Input placeholder="id prefix (optional)" value={draft.prefix} onChange={(e) => setDraft({ ...draft, prefix: e.target.value })} className="h-8 font-mono text-xs" />
            <div className="flex items-center gap-2 sm:col-span-2">
              <Button size="sm" onClick={addSource} disabled={busy === "add" || !draft.id.trim() || !draft.url.trim()}>
                {busy === "add" ? <Loader2 className="animate-spin" /> : <Plus />} Add
              </Button>
              <p className="text-[10px] text-muted-foreground">
                A prefix keeps two libraries that both ship <span className="font-mono">brainstorming</span> apart.
              </p>
            </div>
          </Card>
        )}

        {sources.map((source) => {
          const selected = source.skills.filter((s) => picked.has(`${source.id}:${s.sourceSkill}`));
          const overwrites = selected.some((s) => s.state !== "new");
          return (
            <Card key={source.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{source.name}</span>
                <Badge variant={source.status === "ready" ? "secondary" : source.status === "failed" ? "destructive" : "outline"} className="text-[10px]">
                  {source.status === "ready" ? `${source.skills.length} skills` : source.status}
                </Badge>
                {source.prefix && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {source.prefix}*
                  </Badge>
                )}
                <span className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => sync(source.id)} disabled={busy === `sync:${source.id}`}>
                    <RefreshCw className={cn(busy === `sync:${source.id}` && "animate-spin")} /> Sync
                  </Button>
                  {source.headSha && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title={source.pinnedSha ? "Let Sync follow the remote again" : "Hold this library at the commit it is on"}
                      onClick={() => pin(source, source.pinnedSha ? null : source.headSha)}
                      disabled={busy === `pin:${source.id}`}
                    >
                      {source.pinnedSha ? "Unpin" : "Pin"}
                    </Button>
                  )}
                  {source.skills.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => setOpen(open === source.id ? null : source.id)}>
                      {open === source.id ? "hide" : "browse"}
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" aria-label="Forget" onClick={() => forgetSource(source)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </span>
              </div>

              <p className="break-all font-mono text-[11px] text-muted-foreground">
                {source.url}
                {source.ref ? ` @ ${source.ref}` : ""}
                {source.headSha ? ` · ${source.headSha.slice(0, 12)}` : ""}
                {source.pinnedSha ? ` · pinned at ${source.pinnedSha.slice(0, 12)}` : ""}
              </p>

              {source.status === "new" && (
                <p className="text-[11px] text-muted-foreground">Registered, not pulled. Sync fetches it; nothing is imported until you say so.</p>
              )}
              {source.status === "failed" && source.lastSyncLog && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-muted/30 p-2 font-mono text-[11px]">{source.lastSyncLog}</pre>
              )}

              {open === source.id && (
                <div className="space-y-1">
                  {source.skills.map((skill) => {
                    const key = `${source.id}:${skill.sourceSkill}`;
                    return (
                      <label key={key} className="flex items-start gap-2 rounded px-1 py-1 text-[11px] hover:bg-muted/40">
                        <input type="checkbox" className="mt-1" checked={picked.has(key)} onChange={() => toggle(key)} disabled={!!skill.error} />
                        <span className="min-w-0 flex-1">
                          <span className="font-mono">{skill.id}</span>
                          <Badge variant={STATE[skill.state].variant} className="ml-1.5 text-[9px]">
                            {STATE[skill.state].label}
                          </Badge>
                          <span className="block leading-snug text-muted-foreground">{skill.error ?? skill.description}</span>
                        </span>
                      </label>
                    );
                  })}
                  <div className="flex items-center gap-2 pt-1">
                    <Button size="sm" onClick={() => importPicked(source, overwrites)} disabled={!selected.length || busy === `import:${source.id}`}>
                      {busy === `import:${source.id}` ? <Loader2 className="animate-spin" /> : <DownloadCloud />}
                      {overwrites ? `Import and replace ${selected.length}` : `Import ${selected.length || ""}`}
                    </Button>
                    {overwrites && (
                      <p className="text-[10px] text-destructive">
                        {selected.filter((s) => s.state === "edited").length > 0
                          ? "One of these was edited here; importing overwrites that edit."
                          : "Replaces this team's copies with the upstream ones."}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">This team&apos;s library</h2>
        {skills.length === 0 && <p className="px-1 text-xs text-muted-foreground">Nothing here yet.</p>}
        {skills.map((skill) => (
          <Card key={skill.id} className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <Link href={withTeam(`/skills/${skill.id}`, team)} className="font-mono text-sm hover:underline">
                {skill.id}
              </Link>
              <p className="leading-snug text-[11px] text-muted-foreground">{skill.description}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {skill.origin
                  ? `from ${skill.origin.sourceId}/${skill.origin.sourceSkill}${skill.origin.commit ? ` @ ${skill.origin.commit.slice(0, 12)}` : ""}`
                  : "written here"}
                {skill.resources.length ? ` · ${skill.resources.length} file(s) beside it` : ""}
              </p>
            </div>
            <Button variant="ghost" size="icon" aria-label={`Delete ${skill.id}`} onClick={() => removeSkill(skill.id)}>
              <Trash2 className="size-3.5" />
            </Button>
          </Card>
        ))}

        {errors.map((e) => (
          <Card key={e.id} className="border-destructive/50 p-3 text-[11px] text-destructive">
            <span className="font-mono">{e.id}</span>: {e.message}
          </Card>
        ))}

        {inherited.length > 0 && (
          <>
            <h2 className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Inherited</h2>
            {inherited.map((skill) => (
              <Card key={skill.id} className="p-3">
                <Link href={withTeam(`/skills/${skill.id}`, team)} className="font-mono text-sm hover:underline">
                  {skill.id}
                </Link>
                <p className="leading-snug text-[11px] text-muted-foreground">{skill.description}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Usable here, owned by the default team — edited and deleted where it lives.
                </p>
              </Card>
            ))}
          </>
        )}
      </section>
    </main>
  );
}
