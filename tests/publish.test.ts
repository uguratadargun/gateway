import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  branchAllowed,
  checkpointWork,
  publishBranch,
  DEFAULT_BRANCH_POLICY,
  type PublicationTarget,
  type PublishOutcome,
} from "@/repos/publish";
import { createRunWorkspace, releaseRunWorkspace } from "@/runtime/workspace";

/**
 * Getting a run's work off the machine it ran on.
 *
 * A branch in a worktree on one laptop answers nobody else's question, so a
 * run that ends pushes its branch to the repository's remote. What is checked
 * here is checked against the remote repository itself: a publication that
 * reports a commit the remote does not hold is the failure this feature exists
 * to prevent, and a return value agreeing with itself would not catch it.
 */

const previousHome = process.env.GATE_HOME;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repository with one commit, an identity, and a branch named main. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gate-repo-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  writeFileSync(join(root, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
}

/** A bare remote the repository pushes to. */
function makeRemote(repo: string): string {
  const remote = mkdtempSync(join(tmpdir(), "gate-remote-"));
  git(remote, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", remote);
  return remote;
}

/** A branch with a commit on it, checked out, as a run's branch would be. */
function commitOnBranch(repo: string, branch: string, file: string, body: string): string {
  git(repo, "checkout", "-qb", branch);
  writeFileSync(join(repo, file), `${body}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "work");
  return git(repo, "rev-parse", "HEAD");
}

function target(remote: string, branchPolicy = DEFAULT_BRANCH_POLICY): PublicationTarget {
  return { remote, branchPolicy };
}

/** Every ref the bare remote holds, which is the only account of it that counts. */
function remoteRefs(remote: string): string {
  return git(remote, "for-each-ref", "--format=%(refname)");
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gate-pub-"));
  process.env.GATE_HOME = home;
});

afterAll(() => {
  process.env.GATE_HOME = previousHome;
});

describe("what a repository allows to be published", () => {
  it("matches gate's own branches under gate/* without reaching a level deeper", () => {
    expect(branchAllowed("gate/run-abc", "gate/*")).toBe(true);
    // The promise of `gate/*` is that `*` stops at a slash: a branch two
    // levels down belongs to somebody's own scheme and is not swept up.
    expect(branchAllowed("gate/a/b", "gate/*")).toBe(false);
  });

  it("matches anything under a bare *", () => {
    // A repository whose policy is `*` publishes whatever it is given, and
    // what it is given is always `gate/run-…`: every branch gate makes has a
    // slash in it. Compiling `*` to `[^/]*` makes `*` mean "publish nothing
    // gate ever produces", which is the opposite of what a person setting it
    // is asking for and fails silently, as a policy refusal.
    expect(branchAllowed("wip", "*")).toBe(true);
    expect(branchAllowed("gate/run-abc", "*")).toBe(true);
  });

  it("matches nothing when the policy is empty or only spaces", () => {
    // This is how a repository says "never push from here", so an empty
    // policy read as "no constraint" would publish everything.
    expect(branchAllowed("gate/run-abc", "")).toBe(false);
    expect(branchAllowed("gate/run-abc", "   ")).toBe(false);
  });

  it("reads regex metacharacters in a policy as the characters they are", () => {
    expect(branchAllowed("gate/run-1.2", "gate/run-1.2")).toBe(true);
    // A policy compiled as a regex would let `.` stand for any character, so
    // `gate/run-1.2` would also publish a branch nobody named in it.
    expect(branchAllowed("gate/run-1x2", "gate/run-1.2")).toBe(false);
  });
});

describe("publishing a run's branch", () => {
  it("pushes the branch and reports the commit the remote itself holds", () => {
    const repo = makeRepo();
    const remote = makeRemote(repo);
    const local = commitOnBranch(repo, "gate/run-abc", "work.txt", "work");

    const outcome = publishBranch(repo, "gate/run-abc", target("origin"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.published.ref).toBe("refs/heads/gate/run-abc");
    // Asked of the remote repository, not of the push that claimed to have
    // moved it: recording a commit nobody else can fetch is the whole risk.
    expect(git(remote, "rev-parse", "refs/heads/gate/run-abc")).toBe(local);
    expect(outcome.published.commit).toBe(local);
    expect(git(remote, "show", "gate/run-abc:work.txt")).toBe("work");
  });

  it("leaves the branch without an upstream, so a published worktree is not disposable", () => {
    const repo = makeRepo();
    makeRemote(repo);
    commitOnBranch(repo, "gate/run-noup", "x.txt", "x");

    expect(publishBranch(repo, "gate/run-noup", target("origin")).ok).toBe(true);
    // `isFullyPushed` judges a worktree by its upstream, and `gate clean`
    // removes what it calls fully pushed. A publication that set an upstream
    // would quietly turn every published run's worktree into something to
    // delete, uncommitted work and all.
    expect(() => git(repo, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();
  });

  it("refuses a branch outside the policy and puts nothing on the remote", () => {
    const repo = makeRepo();
    const remote = makeRemote(repo);
    commitOnBranch(repo, "feature/mine", "y.txt", "y");

    const outcome = publishBranch(repo, "feature/mine", target("origin"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("policy");
    // A refusal that pushed first and complained afterwards would have
    // published somebody's own branch from their own checkout.
    expect(remoteRefs(remote)).not.toContain("feature/mine");
  });

  it("reports a failed push rather than throwing when the remote is not a repository", () => {
    const repo = makeRepo();
    const notARepository = mkdtempSync(join(tmpdir(), "gate-not-a-remote-"));
    commitOnBranch(repo, "gate/run-bad", "z.txt", "z");

    // A run whose publication throws is a run that loses its result over a
    // network, so git's refusal has to come back as an ordinary outcome.
    const outcome = publishBranch(repo, "gate/run-bad", target(notARepository));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("push-failed");
  });

  it("says there is no target when the repository names no remote", () => {
    const repo = makeRepo();

    const outcome = publishBranch(repo, "gate/run-abc", null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("no-target");
  });
});

describe("a run that ends in a repository that publishes", () => {
  it("pushes the branch, the leftover commit included, before the worktree goes", () => {
    const repo = makeRepo();
    const remote = makeRemote(repo);
    const ws = createRunWorkspace({ repo }, "pub00001-run");
    writeFileSync(join(ws.root, "left.txt"), "left\n");

    const outcomes: PublishOutcome[] = [];
    const said = releaseRunWorkspace(ws, "pub00001-run", {
      publish: target("origin"),
      onPublished: (o) => outcomes.push(o),
    });

    expect(existsSync(ws.root)).toBe(false);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(true);
    expect(said).toContain(outcomes[0].note);
    // The push has to happen after the leftovers are committed and before the
    // worktree is removed; a remote holding the branch without `left.txt` is
    // the other team fetching a run that looks like it did less than it did.
    expect(git(remote, "show", `${ws.branch}:left.txt`)).toBe("left");
    expect(git(remote, "rev-parse", `refs/heads/${ws.branch}`)).toBe(git(repo, "rev-parse", ws.branch));
  });

  it("pushes nothing when the run changed nothing", () => {
    const repo = makeRepo();
    const remote = makeRemote(repo);
    const ws = createRunWorkspace({ repo }, "pub00002-run");

    const outcomes: PublishOutcome[] = [];
    const said = releaseRunWorkspace(ws, "pub00002-run", {
      publish: target("origin"),
      onPublished: (o) => outcomes.push(o),
    });

    expect(said).toContain("changed nothing");
    expect(existsSync(ws.root)).toBe(false);
    // The branch went with the worktree, so a ref for it on the remote would
    // be one nothing local points at any more: an empty run offers no work.
    expect(remoteRefs(remote)).not.toContain(ws.branch);
    expect(outcomes).toEqual([]);
  });
});

describe("checkpointing work that is not finished", () => {
  it("commits what is in the worktree under a message that calls itself a checkpoint", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "progress.txt"), "half\n");

    const sha = checkpointWork(repo, "asked mid-run");
    // Whoever fetches this must not read unfinished work as a finished piece,
    // so the message says what it is.
    expect(git(repo, "log", "-1", "--format=%s")).toBe("gate checkpoint: asked mid-run");
    expect(sha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(repo, "show", "HEAD:progress.txt")).toBe("half");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("returns null when there is nothing uncommitted to checkpoint", () => {
    const repo = makeRepo();
    const head = git(repo, "rev-parse", "HEAD");

    // An empty checkpoint commit would put a commit on the branch saying work
    // happened when none did.
    expect(checkpointWork(repo, "nothing to say")).toBeNull();
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  });
});
