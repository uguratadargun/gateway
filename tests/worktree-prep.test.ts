import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyClean, judgeWorkspace, planClean, type WorkspaceEntry } from "@/client/clean";
import {
  borrowDependencies,
  createRunWorkspace,
  isFullyPushed,
  readRunDiff,
  releaseRunWorkspace,
  restoreRunWorkspace,
} from "@/runtime/workspace";

/**
 * What a run's worktree starts with, and what happens to it when the run is
 * over.
 *
 * A worktree carries only what git tracks, so a planner following its skill
 * ran a full dependency install per run; the checkout's `node_modules` is
 * lent instead. And a worktree that outlives its run was gigabytes of disk
 * nobody reclaimed, so a run that ends gives it back — its uncommitted work
 * committed onto the branch first, the branch kept, and the worktree checked
 * out again from it when the run is continued.
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

describe("what a run leaves behind when it ends", () => {
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

    const said = releaseRunWorkspace(ws, "tidy0001-run");
    expect(said).toContain("removed");
    expect(existsSync(ws.root)).toBe(false);
    // The branch survives: the work is one checkout away.
    expect(git(repo, "branch", "--list", ws.branch)).toContain(ws.branch);
  });

  it("removes a worktree with unpushed commits too — the branch keeps them", () => {
    const repo = makeRepo();
    const ws = createRunWorkspace({ repo }, "tidy0002-run");
    writeFileSync(join(ws.root, "a.txt"), "a\n");
    git(ws.root, "add", "-A");
    git(ws.root, "commit", "-qm", "work");

    expect(releaseRunWorkspace(ws, "tidy0002-run")).toContain("removed");
    expect(existsSync(ws.root)).toBe(false);
    expect(git(repo, "show", `${ws.branch}:a.txt`)).toBe("a");
  });

  it("commits what the run left uncommitted onto its branch before the worktree goes, and not the borrowed links", () => {
    const repo = makeRepo();
    const ws = createRunWorkspace({ repo }, "tidy0003-run");
    borrowDependencies(ws);
    writeFileSync(join(ws.root, "new.txt"), "new\n");
    writeFileSync(join(ws.root, "package.json"), '{"name":"y"}\n');

    const said = releaseRunWorkspace(ws, "tidy0003-run");
    expect(said).toContain("uncommitted");
    expect(existsSync(ws.root)).toBe(false);
    expect(git(repo, "show", `${ws.branch}:new.txt`)).toBe("new");
    expect(git(repo, "show", `${ws.branch}:package.json`)).toBe('{"name":"y"}');
    expect(git(repo, "log", "-1", "--format=%s", ws.branch)).toContain("left uncommitted");
    // The symlink to the checkout's node_modules is not the run's work.
    expect(git(repo, "ls-tree", "--name-only", ws.branch)).not.toContain("node_modules");
    // And the checkout's own dependencies are untouched by the removal.
    expect(existsSync(join(repo, "node_modules", "left-pad", "index.js"))).toBe(true);
  });

  it("leaves the borrowed link out even where the ignore rule only matches a directory", () => {
    const repo = makeRepo();
    // `node_modules/` does not match a symlink named node_modules.
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "commit", "-qam", "ignore dirs only");
    const ws = createRunWorkspace({ repo }, "tidy0007-run");
    borrowDependencies(ws);
    expect(git(ws.root, "status", "--porcelain")).toContain("node_modules");
    writeFileSync(join(ws.root, "new.txt"), "new\n");

    expect(releaseRunWorkspace(ws, "tidy0007-run")).toContain("removed");
    expect(git(repo, "ls-tree", "--name-only", ws.branch)).not.toContain("node_modules");
    expect(git(repo, "show", `${ws.branch}:new.txt`)).toBe("new");
  });

  it("takes the branch too when the run put nothing on it", () => {
    const repo = makeRepo();
    const ws = createRunWorkspace({ repo }, "tidy0004-run");
    expect(releaseRunWorkspace(ws, "tidy0004-run")).toContain("changed nothing");
    expect(existsSync(ws.root)).toBe(false);
    expect(git(repo, "branch", "--list", ws.branch)).toBe("");
  });

  it("leaves a directory git does not know alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-not-a-worktree-"));
    expect(releaseRunWorkspace({ root: dir, repo: dir, branch: "gate/run-x", baseRef: "HEAD" }, "x")).toBeNull();
    expect(existsSync(dir)).toBe(true);
  });

  it("brings the worktree back from the branch for a continue, and reads the diff from the branch meanwhile", () => {
    const repo = makeRepo();
    const ws = createRunWorkspace({ repo }, "tidy0005-run");
    writeFileSync(join(ws.root, "half.txt"), "half done\n");
    releaseRunWorkspace(ws, "tidy0005-run");
    expect(existsSync(ws.root)).toBe(false);

    const { diff } = readRunDiff(ws.root, ws.baseCommit, { repo: ws.repo, branch: ws.branch });
    expect(diff).toContain("+half done");

    expect(restoreRunWorkspace(ws)).toBe(true);
    expect(readFileSync(join(ws.root, "half.txt"), "utf8")).toBe("half done\n");
    expect(git(ws.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(ws.branch);
    // Already there: nothing to do.
    expect(restoreRunWorkspace(ws)).toBe(false);
  });

  it("cuts the branch again from the base commit when it went with an empty run", () => {
    const repo = makeRepo();
    const ws = createRunWorkspace({ repo }, "tidy0006-run");
    releaseRunWorkspace(ws, "tidy0006-run");
    expect(restoreRunWorkspace(ws)).toBe(true);
    expect(git(ws.root, "rev-parse", "HEAD")).toBe(ws.baseCommit);
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

  it("removes every worktree of a run that is over, only what is plainly done of one it has no record of unless --all, and never a running run", () => {
    const entry = (executionId: string, verdict: WorkspaceEntry["verdict"], status = "failed"): WorkspaceEntry => ({
      executionId,
      root: `/tmp/${executionId}`,
      repo: "/tmp/repo",
      branch: `gate/run-${executionId}`,
      baseCommit: null,
      status: verdict === "running" ? "running" : status,
      verdict,
    });
    const entries = [
      entry("a", "running"),
      entry("b", "pushed", "unknown"),
      entry("c", "empty", "unknown"),
      entry("d", "unpushed", "unknown"),
      entry("e", "dirty", "unknown"),
      entry("f", "dirty", "failed"),
      entry("g", "unpushed", "completed"),
    ];

    const careful = planClean(entries, false);
    expect(careful.removed.map((e) => e.executionId)).toEqual(["b", "c", "f", "g"]);
    expect(careful.kept.map((e) => e.executionId)).toEqual(["a", "d", "e"]);

    const all = planClean(entries, true);
    expect(all.removed.map((e) => e.executionId)).toEqual(["b", "c", "d", "e", "f", "g"]);
    expect(all.kept.map((e) => e.executionId)).toEqual(["a"]);
  });

  it("commits a dirty worktree onto its branch before removing it", () => {
    const repo = makeRepo();
    const ws = createRunWorkspace({ repo }, "clean003-run");
    writeFileSync(join(ws.root, "c.txt"), "c\n");
    const e: WorkspaceEntry = {
      executionId: "clean003-run",
      root: ws.root,
      repo,
      branch: ws.branch,
      baseCommit: ws.baseCommit ?? null,
      status: "failed",
      verdict: "dirty",
    };
    expect(applyClean(planClean([e], false))).toEqual([]);
    expect(existsSync(ws.root)).toBe(false);
    expect(git(repo, "show", `${ws.branch}:c.txt`)).toBe("c");
  });
});
