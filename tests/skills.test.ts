import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { saveAgent } from "@/agents/registry";
import { parseAgent } from "@/agents/loader";
import { scopeAt, teamScope } from "@/lib/def-root";
import { buildSkillPlugin, skillsBriefing, skillsDirective } from "@/skills/inject";
import { parseSkill, SkillDefinitionError, withSkillName } from "@/skills/loader";
import { deleteSkill, getSkill, inheritedSkills, listSkills, saveSkill, skillsDir } from "@/skills/registry";
import { availableSkills, createSource, getSource, importSkills, importState, syncSource } from "@/skills/sources";
import { systemPrompt } from "@/runtime/executors/agent";

const BRAINSTORMING = `---
name: brainstorming
description: Use before any creative work — explores intent before implementation.
---

Ask one question at a time. Present a design and get approval before writing code.
`;

const meta = { dir: "/tmp/s", sourcePath: "/tmp/s/SKILL.md", updatedAt: 0 };

describe("parseSkill", () => {
  it("reads name, description and body", () => {
    const skill = parseSkill("brainstorming", BRAINSTORMING, meta);
    expect(skill.name).toBe("brainstorming");
    expect(skill.description).toContain("before any creative work");
    expect(skill.body).toContain("Ask one question at a time");
  });

  it("keeps frontmatter keys gate has no opinion about", () => {
    const raw = "---\nname: a\ndescription: d\nlicense: MIT\nversion: 3\n---\nbody";
    const skill = parseSkill("a", raw, meta) as unknown as Record<string, unknown>;
    expect(skill.license).toBe("MIT");
    expect(skill.version).toBe(3);
  });

  it("refuses a file with no frontmatter, no body, or no description", () => {
    expect(() => parseSkill("a", "just prose", meta)).toThrow(SkillDefinitionError);
    expect(() => parseSkill("a", "---\nname: a\ndescription: d\n---\n", meta)).toThrow(/no body/);
    expect(() => parseSkill("a", "---\nname: a\n---\nbody", meta)).toThrow(/invalid frontmatter/);
  });

  it("renames a copy without touching anything else", () => {
    const renamed = withSkillName(BRAINSTORMING, "superpowers-brainstorming");
    expect(renamed).toContain("name: superpowers-brainstorming");
    expect(renamed).toContain("Use before any creative work");
    expect(withSkillName(renamed, "superpowers-brainstorming")).toBe(renamed);
  });
});

describe("the skill registry", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gate-skills-"));
    process.env.GATE_HOME = home;
  });

  it("saves, reads back and deletes a skill directory", () => {
    const scope = teamScope();
    saveSkill("brainstorming", BRAINSTORMING, scope);
    expect(getSkill("brainstorming", scope).name).toBe("brainstorming");
    expect(listSkills(scope).skills.map((s) => s.id)).toEqual(["brainstorming"]);
    expect(deleteSkill("brainstorming", scope)).toBe(true);
    expect(listSkills(scope).skills).toEqual([]);
  });

  it("never writes a skill that does not parse", () => {
    const scope = teamScope();
    expect(() => saveSkill("bad", "no frontmatter here", scope)).toThrow(SkillDefinitionError);
    expect(existsSync(join(skillsDir(scope), "bad"))).toBe(false);
  });

  it("lists a directory that does not parse as an error rather than dropping it", () => {
    const scope = teamScope();
    mkdirSync(join(skillsDir(scope), "broken"), { recursive: true });
    writeFileSync(join(skillsDir(scope), "broken", "SKILL.md"), "no frontmatter");
    expect(listSkills(scope).errors.map((e) => e.id)).toEqual(["broken"]);
  });

  it("reports files beside SKILL.md as the skill's own", () => {
    const scope = teamScope();
    saveSkill("brainstorming", BRAINSTORMING, scope);
    const dir = join(skillsDir(scope), "brainstorming");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "companion.md"), "more");
    writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh");
    expect(getSkill("brainstorming", scope).resources.sort()).toEqual(["companion.md", "scripts/run.sh"]);
  });

  it("lets a team inherit the default team's skills and replace one for itself", () => {
    saveSkill("brainstorming", BRAINSTORMING, teamScope());
    const other = teamScope("platform");
    expect(inheritedSkills(other).map((s) => s.id)).toEqual(["brainstorming"]);
    expect(getSkill("brainstorming", other).description).toContain("before any creative work");

    saveSkill("brainstorming", BRAINSTORMING.replace("Use before", "Our own take on when to use it, before"), other);
    expect(getSkill("brainstorming", other).description).toContain("Our own take");
    expect(getSkill("brainstorming", teamScope()).description).not.toContain("Our own take");
    expect(inheritedSkills(other)).toEqual([]);
  });
});

describe("assigning a skill to an agent", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gate-skills-"));
    process.env.GATE_HOME = home;
  });

  const planner = (skills: string) => `---
name: Planner
skills: ${skills}
---
Plan it.
`;

  it("parses a skills list off the frontmatter, defaulting to none", () => {
    expect(parseAgent("p", planner("[brainstorming]"), { sourcePath: "/tmp/p.md", updatedAt: 0 }).skills).toEqual([
      "brainstorming",
    ]);
    expect(parseAgent("p", "---\nname: P\n---\nPlan.", { sourcePath: "/tmp/p.md", updatedAt: 0 }).skills).toEqual([]);
  });

  it("refuses to save an agent naming a skill the team cannot resolve", () => {
    const scope = teamScope();
    expect(() => saveAgent("planner", planner("[brainstorming]"), scope)).toThrow(/unknown skill: brainstorming/);
    saveSkill("brainstorming", BRAINSTORMING, scope);
    expect(saveAgent("planner", planner("[brainstorming]"), scope).skills).toEqual(["brainstorming"]);
  });

  it("accepts a skill the team only inherits", () => {
    saveSkill("brainstorming", BRAINSTORMING, teamScope());
    const other = teamScope("platform");
    expect(saveAgent("planner", planner("[brainstorming]"), other).skills).toEqual(["brainstorming"]);
  });
});

describe("delivering a skill to a model", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gate-skills-"));
    process.env.GATE_HOME = home;
  });

  it("folds the whole skill into gate's own system prompt", () => {
    const skill = saveSkill("brainstorming", BRAINSTORMING, teamScope());
    const agent = parseAgent("p", "---\nname: Planner\n---\nPlan.", { sourcePath: "/tmp/p.md", updatedAt: 0 });
    const prompt = systemPrompt(agent, false, false, [skill]);
    expect(prompt).toContain("Ask one question at a time");
    expect(prompt).toContain("brainstorming");
    // Nothing is said about skills when none were declared.
    expect(systemPrompt(agent, false, false, [])).not.toContain("# Skills");
  });

  it("warns gate's own loop that a skill's other files are out of reach", () => {
    const skill = saveSkill("brainstorming", BRAINSTORMING, teamScope());
    writeFileSync(join(skillsDir(teamScope()), "brainstorming", "companion.md"), "more");
    const reloaded = getSkill("brainstorming", teamScope());
    expect(skillsBriefing([reloaded])).toContain("companion.md");
    expect(skillsBriefing([reloaded])).toContain("not readable");
    expect(skillsBriefing([skill])).toContain("Ask one question");
  });

  it("builds a Claude Code plugin carrying the skill and its files", () => {
    saveSkill("superpowers-brainstorming", BRAINSTORMING, teamScope());
    const dir = join(skillsDir(teamScope()), "superpowers-brainstorming");
    writeFileSync(join(dir, "companion.md"), "more");
    const skill = getSkill("superpowers-brainstorming", teamScope());

    const plugin = buildSkillPlugin([skill])!;
    expect(existsSync(join(plugin, ".claude-plugin", "plugin.json"))).toBe(true);
    const copied = join(plugin, "skills", "superpowers-brainstorming");
    expect(readFileSync(join(copied, "companion.md"), "utf8")).toBe("more");
    // Renamed to the id it is known by here, so the harness and gate agree.
    expect(readFileSync(join(copied, "SKILL.md"), "utf8")).toContain("name: superpowers-brainstorming");
    // Content-addressed: the same skills build once.
    expect(buildSkillPlugin([skill])).toBe(plugin);
    expect(buildSkillPlugin([])).toBe(null);
    // Named the way the harness namespaces it, so the child can invoke it.
    expect(skillsDirective([skill])).toContain("gate-skills:superpowers-brainstorming");
  });

  it("rebuilds under a new address when the skill changes", () => {
    saveSkill("brainstorming", BRAINSTORMING, teamScope());
    const first = buildSkillPlugin([getSkill("brainstorming", teamScope())]);
    saveSkill("brainstorming", BRAINSTORMING.replace("Ask one", "Ask exactly one"), teamScope());
    expect(buildSkillPlugin([getSkill("brainstorming", teamScope())])).not.toBe(first);
  });
});

describe("pulling skills from a source", () => {
  let home: string;
  let upstream: string;

  /** A real git repository laid out the way a skill library is. */
  function makeUpstream(description: string): string {
    const root = mkdtempSync(join(tmpdir(), "gate-upstream-"));
    mkdirSync(join(root, "skills", "brainstorming", "scripts"), { recursive: true });
    writeFileSync(join(root, "skills", "brainstorming", "SKILL.md"), BRAINSTORMING.replace("Use before any creative work — explores intent before implementation.", description));
    writeFileSync(join(root, "skills", "brainstorming", "scripts", "helper.sh"), "#!/bin/sh\necho hi\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("add", "-A");
    git("commit", "-qm", "skills");
    return root;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gate-skills-"));
    process.env.GATE_HOME = home;
    upstream = makeUpstream("Use before any creative work.");
  });

  it("clones, lists, imports with provenance, and tracks what upstream did next", async () => {
    createSource({ id: "house", name: "House", url: upstream, subdir: "skills", prefix: "house-" });
    expect(await syncSource("house")).toMatchObject({ status: "ready" });

    const source = getSource("house")!;
    const available = availableSkills(source);
    expect(available.map((s) => s.id)).toEqual(["house-brainstorming"]);

    const scope = teamScope();
    expect(importState(available[0], scope)).toBe("new");

    const result = importSkills("house", ["brainstorming"], scope);
    expect(result.imported).toEqual(["house-brainstorming"]);

    const imported = getSkill("house-brainstorming", scope);
    // The whole directory, not just the prose it points from.
    expect(imported.resources).toEqual(["scripts/helper.sh"]);
    expect(imported.origin).toMatchObject({ sourceId: "house", sourceSkill: "brainstorming" });
    expect(imported.name).toBe("house-brainstorming");
    expect(importState(availableSkills(getSource("house")!)[0], scope)).toBe("current");

    // Importing the same skill again is refused rather than silently redone.
    expect(importSkills("house", ["brainstorming"], scope).skipped[0].reason).toMatch(/already here/);

    // Upstream moves; the library does not, until somebody says so.
    writeFileSync(join(upstream, "skills", "brainstorming", "SKILL.md"), BRAINSTORMING.replace("Ask one", "Ask precisely one"));
    execFileSync("git", ["commit", "-aqm", "reword"], { cwd: upstream, stdio: "pipe" });
    await syncSource("house");
    expect(importState(availableSkills(getSource("house")!)[0], scope)).toBe("outdated");
    expect(getSkill("house-brainstorming", scope).body).toContain("Ask one question");

    importSkills("house", ["brainstorming"], scope, true);
    expect(getSkill("house-brainstorming", scope).body).toContain("Ask precisely one");
  });

  it("calls a locally edited skill edited, not outdated", async () => {
    createSource({ id: "edited-case", name: "House", url: upstream, subdir: "skills", prefix: "" });
    await syncSource("edited-case");
    const scope = teamScope();
    importSkills("edited-case", ["brainstorming"], scope);
    saveSkill("brainstorming", `${readFileSync(join(skillsDir(scope), "brainstorming", "SKILL.md"), "utf8")}\nOur own extra rule.\n`, scope);
    expect(importState(availableSkills(getSource("edited-case")!)[0], scope)).toBe("edited");
  });

  it("records a source it cannot reach as failed, with git's own words", async () => {
    createSource({ id: "gone", name: "Gone", url: join(home, "not-a-repo"), subdir: "skills" });
    const synced = await syncSource("gone");
    expect(synced?.status).toBe("failed");
    expect(synced?.lastSyncLog ?? "").not.toBe("");
  });

  it("mirrors a skill into a client cache scope as the same directory", async () => {
    createSource({ id: "mirror-case", name: "House", url: upstream, subdir: "skills" });
    await syncSource("mirror-case");
    const cache = scopeAt(mkdtempSync(join(tmpdir(), "gate-cache-")));
    importSkills("mirror-case", ["brainstorming"], cache);
    expect(getSkill("brainstorming", cache).resources).toEqual(["scripts/helper.sh"]);
    rmSync(cache.root, { recursive: true, force: true });
  });
});
