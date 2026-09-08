"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Save, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useTeamScope, withTeam } from "@/components/team-picker";

/**
 * One skill, as the file it is.
 *
 * No form here, unlike the agent editor: a skill's frontmatter is two fields
 * and everything that matters is the prose below it, so a form would be
 * chrome around a textarea. The file is what people who write skills already
 * know how to read.
 */

interface SkillDetail {
  id: string;
  name: string;
  description: string;
  resources: string[];
  sourcePath: string;
  updatedAt: number;
  origin: { sourceId: string; sourceSkill: string; commit: string | null; importedAt: number } | null;
}

export default function SkillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [usedBy, setUsedBy] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { team, ready } = useTeamScope();

  useEffect(() => {
    if (!ready) return;
    (async () => {
      const r = await fetch(withTeam(`/api/skills/${id}`, team));
      const data = await r.json();
      if (!r.ok) {
        setError(data.error);
        return;
      }
      setSkill(data.skill);
      setUsedBy(data.usedBy ?? []);
      setSource(data.source);
      setSavedSource(data.source);
    })();
  }, [id, team, ready]);

  const save = useCallback(async () => {
    setBusy(true);
    const r = await fetch(withTeam(`/api/skills/${id}`, team), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const data = await r.json();
    setBusy(false);
    if (!r.ok) {
      setError(data.error ?? "invalid skill");
      return;
    }
    setError(null);
    setSkill(data.skill);
    setSource(data.source);
    setSavedSource(data.source);
  }, [id, source, team]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  async function remove() {
    if (!confirm(`Delete skill "${id}"? The whole directory goes, files and all.`)) return;
    await fetch(withTeam(`/api/skills/${id}`, team), { method: "DELETE" });
    router.push(withTeam("/skills", team));
  }

  const dirty = source !== savedSource;

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-6 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={withTeam("/skills", team)}>
            <Button variant="ghost" size="icon" aria-label="Back">
              <ArrowLeft />
            </Button>
          </Link>
          <div>
            <h1 className="font-mono text-lg font-semibold">{id}</h1>
            <p className="text-xs text-muted-foreground">{skill?.sourcePath ?? "…"}</p>
          </div>
          {skill?.origin && (
            <Badge variant="outline" className="text-[10px]">
              {skill.origin.sourceId}/{skill.origin.sourceSkill}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete">
            <Trash2 />
          </Button>
          <Button onClick={save} disabled={busy || !dirty}>
            <Save /> {dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </header>

      {error && <Card className="border-destructive/50 p-3 text-sm text-destructive">{error}</Card>}

      {skill && (
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          {usedBy.length > 0 ? (
            <span>
              Worked by:{" "}
              {usedBy.map((agent, i) => (
                <span key={agent}>
                  {i > 0 && ", "}
                  <Link href={withTeam(`/agents/${agent}`, team)} className="font-mono text-foreground/80 hover:underline">
                    {agent}
                  </Link>
                </span>
              ))}
            </span>
          ) : (
            <span>No agent names this skill yet — assign it in an agent&apos;s editor.</span>
          )}
          {skill.resources.length > 0 && (
            <span className="font-mono">· {skill.resources.join(", ")}</span>
          )}
        </div>
      )}

      <Textarea
        value={source}
        onChange={(e) => setSource(e.target.value)}
        spellCheck={false}
        className="h-[70vh] resize-none font-mono text-xs leading-relaxed"
      />
      <p className="text-[11px] text-muted-foreground">
        SKILL.md as it is on disk: <span className="font-mono">name</span> and <span className="font-mono">description</span>{" "}
        in the frontmatter, the process below it. The description is how a model decides to reach for the skill, so it
        says when to use it rather than what it is. Only this file is written here — the files beside it are edited on
        disk or replaced by re-importing. ⌘S saves.
      </p>
    </main>
  );
}
