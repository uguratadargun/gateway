import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { load as parseYaml } from "js-yaml";

import { createExecution, getExecution, getExecutionDiff, getExecutionSteps, setExecutionPublication } from "@/executions/store";
import { createTeam, getTeam } from "@/lib/teams";
import { getExtraction } from "@/memory/store";
import { recordMergesSince } from "@/memory/merges";
import { indexRepo } from "@/memory/record-index";
import { MERGE_WORKFLOW_ID } from "@/memory/types";
import { createRepo, type RepoRecord } from "@/repos/store";
import { DEFAULT_WORKFLOWS } from "@/workflows/defaults";

/**
 * Two things a base branch says that gate now listens to, against real git:
 * a decision number another branch took first, and a merge nobody ran
 * through gate.
 */

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

/** A bare remote with main, and a clone of it to work in. */
function upstream(): { remote: string; work: string; base: string } {
  const work = temp("gate-rn-work-");
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "T");
  write(work, "docs/decisions/0001-first.md", "# 0001. First\n");
  write(work, "docs/specs/.keep", "");
  const base = commit(work, "init");
  const remote = temp("gate-rn-remote-");
  git(remote, "init", "-q", "--bare");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { remote, work, base };
}

/** The shipped `record` node's script, as a run would execute it against `base`. */
function recordScript(workflow: string, base: string): string {
  const doc = parseYaml(DEFAULT_WORKFLOWS[workflow]) as { nodes: Array<{ id: string; command?: string[] }> };
  const node = doc.nodes.find((x) => x.id === "record")!;
  return node.command![2].replaceAll("{{outputs.base.stdout}}", base);
}

function runRecord(workflow: string, cwd: string, base: string): { ok: boolean; out: string } {
  const r = spawnSync("sh", ["-c", recordScript(workflow, base)], { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

describe("a decision number another branch took first", () => {
  for (const workflow of ["dev", "dev-auto", "dev-quick"]) {
    it(`is named by ${workflow}'s record node before the branch is offered, and a free one passes`, () => {
      const { remote, work, base } = upstream();
      const branch = temp("gate-rn-branch-");
      git(branch, "clone", "-q", remote, branch);
      git(branch, "config", "user.email", "t@example.com");
      git(branch, "config", "user.name", "T");
      git(branch, "checkout", "-q", "-b", "gate/run-x");
      write(branch, "docs/specs/2026-09-23-thing.md", "Status: done\n");
      write(branch, "docs/decisions/0002-mine.md", "# 0002. Mine\n");
      commit(branch, "mine");

      // Nobody else has 0002 yet: the record is in order.
      expect(runRecord(workflow, branch, base)).toMatchObject({ ok: true });

      // Another branch merged its own 0002 first.
      write(work, "docs/decisions/0002-theirs.md", "# 0002. Theirs\n");
      commit(work, "theirs");
      git(work, "push", "-q", "origin", "main");
      const clash = runRecord(workflow, branch, base);
      expect(clash.ok).toBe(false);
      expect(clash.out).toContain("docs/decisions/0002-mine.md");
      expect(clash.out).toContain("next free number after 0002");

      // Renumbered, it passes again.
      git(branch, "mv", "docs/decisions/0002-mine.md", "docs/decisions/0003-mine.md");
      commit(branch, "Renumber decision records");
      expect(runRecord(workflow, branch, base)).toMatchObject({ ok: true });
    });
  }

  it("still asks for the spec first, and skips the number check when the remote cannot be reached", () => {
    const { base, work } = upstream();
    git(work, "checkout", "-q", "-b", "gate/run-y");
    write(work, "docs/decisions/0001-dup.md", "# 0001. Dup\n");
    commit(work, "dup");
    const noSpec = runRecord("dev", work, base);
    expect(noSpec.ok).toBe(false);
    expect(noSpec.out).toContain("No spec under docs/specs/");

    write(work, "docs/specs/2026-09-23-y.md", "Status: done\n");
    commit(work, "spec");
    git(work, "remote", "set-url", "origin", "/nonexistent/remote");
    expect(runRecord("dev", work, base)).toMatchObject({ ok: true });
  });
});

describe("a merge nobody ran through gate", () => {
  function tree() {
    if (!getTeam("mg-ulak")) {
      createTeam("MG Ulak", "mg-ulak");
      createTeam("MG Server", "mg-server", "mg-ulak");
    }
  }

  let n = 0;
  function connect(): { work: string; repo: RepoRecord; base: string } {
    tree();
    const { remote, work, base } = upstream();
    const checkout = temp("gate-rn-checkout-");
    git(checkout, "clone", "-q", remote, checkout);
    const id = `mg-repo-${++n}`;
    const repo = createRepo({
      id,
      name: id,
      source: checkout,
      root: checkout,
      remoteUrl: `git@github.com:ulak/${id}.git`,
      cloned: false,
      baseRef: "main",
      setup: [],
      prepare: [],
      teamId: "mg-server",
    });
    return { work, repo, base };
  }

  it("is kept as a finished run of gate:merge, for the recorder, with the documents it brought in", async () => {
    const { work, repo, base } = connect();
    git(work, "checkout", "-q", "-b", "feature/batch");
    write(work, "api/sync.go", "// batch\n");
    write(work, "docs/decisions/0002-batch-the-sync-endpoint.md", "# 0002. Batch the sync endpoint\n\n## Decision\nAn array per request.\n");
    commit(work, "feat(sync): accept a batch");
    git(work, "checkout", "-q", "main");
    git(work, "merge", "-q", "--no-ff", "feature/batch", "-m", "Merge feature/batch: batched sync");
    const merge = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "origin", "main");
    await indexRepo(repo);

    expect(await recordMergesSince(repo, base, merge)).toBe(1);
    const { getDb } = await import("@/lib/db");
    const row = getDb().prepare("SELECT id FROM workflow_executions WHERE workflow_id = ? AND json_extract(workspace_json, '$.commit') = ?").get(MERGE_WORKFLOW_ID, merge) as { id: string };
    const run = getExecution(row.id)!;
    expect(run).toMatchObject({ status: "completed", teamId: "mg-server", repoId: repo.repoId });
    expect(run.workspace?.changedFiles).toEqual(expect.arrayContaining(["api/sync.go", "docs/decisions/0002-batch-the-sync-endpoint.md"]));
    const [step] = getExecutionSteps(run.id);
    expect(JSON.stringify(step.output)).toContain("feat(sync): accept a batch");
    expect(getExecutionDiff(run.id)).toContain("+# 0002. Batch the sync endpoint");
    expect(getExtraction(run.id)?.status).toBe("pending");

    // Seen once is recorded once.
    expect(await recordMergesSince(repo, base, merge)).toBe(0);
  });

  it("leaves a merge of a gate run's own branch to the run that made it", async () => {
    const { work, repo, base } = connect();
    git(work, "checkout", "-q", "-b", "gate/run-abcdef12");
    write(work, "api/x.go", "// x\n");
    const head = commit(work, "x");
    git(work, "checkout", "-q", "main");
    git(work, "merge", "-q", "--no-ff", "gate/run-abcdef12", "-m", "Merge branch 'feature'");
    const merge = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "origin", "main");
    const runId = `mg-run-${++n}`;
    createExecution(runId, "dev", { task: "x" }, Date.now(), null, { teamId: "mg-server", repoId: repo.repoId });
    setExecutionPublication(runId, { ref: "gate/run-abcdef12", commit: head, at: Date.now() });
    await indexRepo(repo);
    expect(await recordMergesSince(repo, base, merge)).toBe(0);
  });
});
