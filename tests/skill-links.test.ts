import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { teamScope } from "@/lib/def-root";
import { getSkill } from "@/skills/registry";
import { createSource, getSource, importSkills, pinSource, rewriteSiblingReferences, syncSource } from "@/skills/sources";

/**
 * Two ways a library can stop meaning what an agent was told it means.
 *
 * Imported under a prefix, a skill's references to its siblings — a relative
 * path, the harness namespace — name directories that are not there. And a
 * library that follows its remote changes under prompts written against one
 * version of it; a pin holds it still until somebody moves it.
 */

const previousHome = process.env.GATE_HOME;
let home: string;

const SKILL = (name: string, body: string) => `---
name: ${name}
description: ${name} for tests.
---

${body}
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A library of three skills that refer to each other the way superpowers does. */
function makeUpstream(): string {
  const root = mkdtempSync(join(tmpdir(), "gate-lib-"));
  for (const [name, body] of [
    ["driving", "Dispatch the final reviewer with [code-reviewer.md](../reviewing/code-reviewer.md), then use house:finishing to finish. Never touch ../unrelated/."],
    ["reviewing", "Review the change. See also house:driving for the loop."],
    ["finishing", "Present the options."],
  ] as const) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), SKILL(name, body));
  }
  writeFileSync(join(root, "skills", "reviewing", "code-reviewer.md"), "Template: read ../driving/SKILL.md first.\n");
  writeFileSync(join(root, "skills", "reviewing", "run.sh"), "#!/bin/sh\ncat ../driving/SKILL.md\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "v1");
  return root;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gate-links-"));
  process.env.GATE_HOME = home;
});

afterAll(() => {
  process.env.GATE_HOME = previousHome;
});

describe("a skill's references to its siblings", () => {
  it("are rewritten to the prefixed ids on import, in prose only, and only for names the source holds", async () => {
    const upstream = makeUpstream();
    createSource({ id: "house", name: "House", url: upstream, subdir: "skills", prefix: "house-" });
    await syncSource("house");
    const scope = teamScope();
    expect(importSkills("house", ["driving", "reviewing"], scope).imported).toEqual(["house-driving", "house-reviewing"]);

    const driving = getSkill("house-driving", scope).body;
    expect(driving).toContain("(../house-reviewing/code-reviewer.md)");
    expect(driving).toContain("use house-finishing to finish");
    // A path to something the source does not ship is not gate's to rewrite.
    expect(driving).toContain("../unrelated/");

    const template = readFileSync(join(scope.root, "skills", "house-reviewing", "code-reviewer.md"), "utf8");
    expect(template).toContain("../house-driving/SKILL.md");
    // A script is not prose: left exactly as written.
    expect(readFileSync(join(scope.root, "skills", "house-reviewing", "run.sh"), "utf8")).toContain("../driving/SKILL.md");
    // Already rewritten text is not rewritten twice.
    expect(rewriteSiblingReferences(join(scope.root, "skills", "house-driving"), "house", "house-", ["driving", "reviewing", "finishing"])).toEqual([]);
    expect(getSkill("house-driving", scope).body).not.toContain("house-house-");
  });

  it("does nothing without a prefix: the directories are already what the text says", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-noprefix-"));
    writeFileSync(join(dir, "SKILL.md"), "see ../reviewing/x.md and house:reviewing");
    expect(rewriteSiblingReferences(dir, "house", "", ["reviewing"])).toEqual([]);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("see ../reviewing/x.md and house:reviewing");
  });
});

describe("pinning a library", () => {
  it("holds the clone at the pinned commit through a sync that would otherwise move it", async () => {
    const upstream = makeUpstream();
    const v1 = git(upstream, "rev-parse", "HEAD");
    createSource({ id: "pinned", name: "Pinned", url: upstream, subdir: "skills", prefix: "p-" });
    await syncSource("pinned");
    expect(getSource("pinned")?.headSha).toBe(v1);

    expect(pinSource("pinned", v1)?.pinnedSha).toBe(v1);
    expect(() => pinSource("pinned", "not a sha")).toThrow(/commit sha/);

    // Upstream moves on.
    writeFileSync(join(upstream, "skills", "finishing", "SKILL.md"), SKILL("finishing", "Present exactly two options."));
    git(upstream, "commit", "-aqm", "v2");
    const v2 = git(upstream, "rev-parse", "HEAD");
    expect(v2).not.toBe(v1);

    const held = await syncSource("pinned");
    expect(held?.status).toBe("ready");
    expect(held?.headSha).toBe(v1);
    expect(held?.lastSyncLog).toContain("held at pinned commit");
    expect(readFileSync(join(held!.root, "skills", "finishing", "SKILL.md"), "utf8")).toContain("Present the options.");

    // Unpinned, the next sync follows the remote again.
    expect(pinSource("pinned", null)?.pinnedSha).toBeNull();
    const moved = await syncSource("pinned");
    expect(moved?.headSha).toBe(v2);
    expect(readFileSync(join(moved!.root, "skills", "finishing", "SKILL.md"), "utf8")).toContain("exactly two");
  });
});
