import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { judgeWorkspace, planClean, type WorkspaceEntry } from "@/client/clean";
import { borrowDependencies, createRunWorkspace, isFullyPushed, tidyRunWorkspace } from "@/runtime/workspace";

/**
 * What a run's worktree starts with, and what happens to it when the run is
 * over.
 *
 * A worktree carries only what git tracks, so a planner following its skill
 * ran a full dependency install per run; the checkout's `node_modules` is
 * lent instead. And a worktree whose every commit is on the remote is a copy
 * of something git already holds, so a finished run gives it back — keeping
 * the branch, and keeping anything that is not on the remote.
 */

const previousHome = process.env.GATE_HOME;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repository with one commit and an installed dependency directory. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gate-repo-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  writeFileSync(join(root, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  return root;
}

/** A bare remote the repository pushes to. */
function makeRemote(repo: string): string {
  const remote = mkdtempSync(join(tmpdir(), "gate-remote-"));
  git(remote, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", remote);
  return remote;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gate-wt-"));
  process.env.GATE_HOME = home;
});

afterAll(() => {
  process.env.GATE_HOME = previousHome;
});

describe("a fresh worktree", () => {
  it("borrows the checkout's installed dependencies instead of carrying none", () => {
    const repo = makeRepo();
    const ws = createRunWorkspace({ repo }, "borrow01-run");
    expect(existsSync(join(ws.root, "node_modules"))).toBe(false);

    expect(borrowDependencies(ws)).toEqual(["node_modules"]);
    expect(lstatSync(join(ws.root, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(ws.root, "node_modules", "left-pad", "index.js"))).toBe(true);
    // Linking twice is nothing: the directory is already there.
    expect(borrowDependencies(ws)).toEqual([]);
    // The link is not the run's work: the worktree still reads clean.
    expect(git(ws.root, "status", "--porcelain")).toBe("");
  });
});

describe("what a finished run leaves behind", () => {
  it("removes a worktree whose every commit is on the remote, keeping the branch", () => {
    const repo = makeRepo();
    makeRemote(repo);
    const ws = createRunWorkspace({ repo }, "tidy0001-run");
    writeFileSync(join(ws.root, "a.txt"), "a\n");
    git(ws.root, "add", "-A");
    git(ws.root, "commit", "-qm", "work");
    expect(isFullyPushed(ws.root)).toBe(false);

    git(ws.root, "push", "-q", "--set-upstream", "origin", ws.branch);
    expect(isFullyPushed(ws.root)).toBe(true);

    const said = tidyRunWorkspace(ws);
    expect(said).toContain("removed");
    expect(existsSync(ws.root)).toBe(false);
    // The branch survives: the work is one checkout away.
    expect(git(repo, "branch", "--list", ws.branch)).toContain(ws.branch);
  });

  it("keeps a worktree with anything unpushed or uncommitted", () => {
    const repo = makeRepo();
    makeRemote(repo);
    const unpushed = createRunWorkspace({ repo }, "tidy0002-run");
    writeFileSync(join(unpushed.root, "a.txt"), "a\n");
    git(unpushed.root, "add", "-A");
    git(unpushed.root, "commit", "-qm", "work");
    expect(tidyRunWorkspace(unpushed)).toBeNull();
    expect(existsSync(unpushed.root)).toBe(true);

    const dirty = createRunWorkspace({ repo }, "tidy0003-run");
    writeFileSync(join(dirty.root, "b.txt"), "b\n");
    expect(tidyRunWorkspace(dirty)).toBeNull();
    expect(existsSync(dirty.root)).toBe(true);
  });
});

describe("gate clean", () => {
  it("judges a worktree by what git holds: pushed, empty, unpushed, dirty", () => {
    const repo = makeRepo();
    makeRemote(repo);
    const base = git(repo, "rev-parse", "HEAD");

    const empty = createRunWorkspace({ repo }, "clean001-run");
    expect(judgeWorkspace(empty.root, base)).toBe("empty");

    const unpushed = createRunWorkspace({ repo }, "clean002-run");
    writeFileSync(join(unpushed.root, "a.txt"), "a\n");
    git(unpushed.root, "add", "-A");
    git(unpushed.root, "commit", "-qm", "work");
    expect(judgeWorkspace(unpushed.root, base)).toBe("unpushed");

    git(unpushed.root, "push", "-q", "--set-upstream", "origin", unpushed.branch);
    expect(judgeWorkspace(unpushed.root, base)).toBe("pushed");

    writeFileSync(join(unpushed.root, "b.txt"), "b\n");
    expect(judgeWorkspace(unpushed.root, base)).toBe("dirty");
  });

  it("removes only what is plainly done, unless told --all, and never a running run", () => {
    const entry = (executionId: string, verdict: WorkspaceEntry["verdict"]): WorkspaceEntry => ({
      executionId,
      root: `/tmp/${executionId}`,
      repo: "/tmp/repo",
      branch: `gate/run-${executionId}`,
      status: verdict === "running" ? "running" : "failed",
      verdict,
    });
    const entries = [entry("a", "running"), entry("b", "pushed"), entry("c", "empty"), entry("d", "unpushed"), entry("e", "dirty")];

    const careful = planClean(entries, false);
    expect(careful.removed.map((e) => e.executionId)).toEqual(["b", "c"]);
    expect(careful.kept.map((e) => e.executionId)).toEqual(["a", "d", "e"]);

    const all = planClean(entries, true);
    expect(all.removed.map((e) => e.executionId)).toEqual(["b", "c", "d", "e"]);
    expect(all.kept.map((e) => e.executionId)).toEqual(["a"]);
  });
});
