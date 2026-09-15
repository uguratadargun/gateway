import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createExecution, deleteExecution, setExecutionPublication, setExecutionWorkspace } from "@/executions/store";
import { createTeam, teamAncestors } from "@/lib/teams";
import { replaceDecisions } from "@/memory/store";
import { fetchAskSource, memoryAt, resolveAskSource, type AskSource } from "@/orchestration/ask";
import { createRepo, deleteRepo, type RepoRecord } from "@/repos/store";

/**
 * Where a question's answer is allowed to come from.
 *
 * Every test here builds real repositories and asks git what it thinks, because
 * the failures this half of `gate ask` exists to prevent are all failures of
 * agreement with git: a branch name answered at a commit it no longer points
 * at, a ref that is missing read as work that was never done, a commit nobody
 * fetched read as if it were in this checkout's history.
 */

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function identify(root: string): void {
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
}

/** A repository somebody else works in, and the bare remote they publish to. */
function makeUpstream(): { remote: string; work: string } {
  const work = temp("gate-ask-work-");
  git(work, "init", "-q", "-b", "main");
  identify(work);
  writeFileSync(join(work, "README.md"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "init");
  const remote = temp("gate-ask-remote-");
  git(remote, "init", "-q", "--bare");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  return { remote, work };
}

/** A commit on a branch of the upstream repository, pushed. */
function pushCommit(work: string, remote: string, branch: string, body: string): string {
  git(work, "checkout", "-q", "-B", branch);
  writeFileSync(join(work, `${branch.replace(/\W/g, "-")}.txt`), `${body}\n`);
  git(work, "add", "-A");
  git(work, "commit", "-qm", body);
  git(work, "push", "-q", remote, branch);
  return git(work, "rev-parse", "HEAD");
}

/** This gate's own checkout of that repository. */
function makeCheckout(remote: string): string {
  const root = temp("gate-ask-checkout-");
  git(root, "clone", "-q", remote, root);
  identify(root);
  return root;
}

function tree(): void {
  if (!teamAncestors("ulak").length) {
    createTeam("Ulak", "ulak");
    createTeam("Server", "srv", "ulak");
    createTeam("Desktop", "desktop", "ulak");
    createTeam("Other Co", "otherco");
  }
}

let n = 0;

/** A repository connected to this gate, with the identity a decision carries. */
function connect(over: { root: string; teamId?: string | null; publicationRemote?: string | null; baseRef?: string | null }): RepoRecord {
  tree();
  const id = `ask-repo-${++n}`;
  return createRepo({
    id,
    name: id,
    source: over.root,
    root: over.root,
    remoteUrl: `git@github.com:ulak/${id}.git`,
    cloned: false,
    baseRef: over.baseRef ?? null,
    setup: [],
    prepare: [],
    teamId: over.teamId === undefined ? "desktop" : over.teamId,
    publicationRemote: over.publicationRemote ?? null,
  });
}

/** A run of desktop's that worked in this repository. */
function runIn(repo: RepoRecord, teamId = "desktop", branch = "gate/run-ask"): string {
  const id = `ask-run-${++n}`;
  createExecution(id, "dev", {}, Date.now(), null, { teamId, repoId: repo.repoId });
  setExecutionWorkspace(id, { root: repo.root, repo: repo.id, branch, baseRef: "main", commit: null, changedFiles: [] });
  return id;
}

const question = "how did desktop do the handshake";

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("resolving a question to one commit", () => {
  it("resolves a branch on the publication remote to the commit the remote holds", () => {
    const { remote, work } = makeUpstream();
    const head = pushCommit(work, remote, "release", "shipped");
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote });

    const resolved = resolveAskSource({ question, repo: repo.repoId, ref: "release" }, "srv");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Asked of the remote itself: a resolution that agreed only with gate's
    // own clone would answer at whatever this machine last fetched.
    expect(resolved.source.commit).toBe(git(remote, "rev-parse", "refs/heads/release"));
    expect(resolved.source.commit).toBe(head);
    expect(resolved.source.via).toBe("ref");
  });

  it("uses the repository's base ref when the question names none", () => {
    const { remote, work } = makeUpstream();
    const release = pushCommit(work, remote, "release", "shipped");
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote, baseRef: "release" });

    const resolved = resolveAskSource({ question, repo: repo.repoId }, "srv");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Falling back to HEAD instead would answer from whatever branch the
    // remote happens to point HEAD at, which is not what the repository says
    // its work lives on.
    expect(resolved.source.ref).toBe("release");
    expect(resolved.source.commit).toBe(release);
  });

  it("says the ref is not there without saying the work is not", () => {
    const { remote } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote });

    const resolved = resolveAskSource({ question, repo: repo.repoId, ref: "feature/pq-rekey" }, "srv");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.status).toBe("source_unavailable");
    // The whole feature turns on this sentence: an unpublished branch is not
    // evidence that the feature was never built, and a reason that read as if
    // it were is how that argument starts.
    expect(resolved.reason).toContain("may exist without having been published");
    expect(resolved.reason).toContain("feature/pq-rekey");
    expect(resolved.status === "source_unavailable" && resolved.publish).toEqual({ repo: repo.id, ref: "feature/pq-rekey" });
  });

  it("names the repository that has to publish before it can be read", () => {
    const { remote } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: null });

    const resolved = resolveAskSource({ question, repo: repo.repoId, ref: "main" }, "srv");
    expect(resolved.ok).toBe(false);
    if (resolved.ok || resolved.status !== "source_unavailable") return;
    // Whoever reads this has to go and do something to a named repository.
    expect(resolved.reason).toContain(repo.id);
    expect(resolved.publish).toEqual({ repo: repo.id, ref: "main" });
  });

  it("takes a well-formed commit as given, without asking the remote about it", () => {
    const { remote } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote });
    const absent = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    const resolved = resolveAskSource({ question, repo: repo.repoId, commit: absent }, "srv");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The remote has never heard of this commit. An asker who already has one
    // is answered from it anyway — resolution is not the step that verifies
    // reachability, `fetchAskSource` is, and it says so in its own words.
    expect(resolved.source.commit).toBe(absent);
    expect(resolved.source.via).toBe("commit");
  });

  it("refuses something that is not a commit rather than passing it to git", () => {
    const { remote } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote });

    const resolved = resolveAskSource({ question, repo: repo.repoId, commit: "HEAD~3; rm -rf /" }, "srv");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.status).toBe("not_found");
  });
});

describe("the family as the boundary", () => {
  it("refuses a repository outside the asker's family in the same words a missing one gets", () => {
    const { remote } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote, teamId: "otherco" });
    const name = repo.repoId!;

    const refused = resolveAskSource({ question, repo: name, ref: "main" }, "srv");
    // Now ask the same question about a repository this gate really does not
    // have. Which repositories another company keeps here is not something to
    // confirm by the shape of the refusal, so the two must be the same word
    // for word.
    expect(deleteRepo(repo.id)).toBe(true);
    const missing = resolveAskSource({ question, repo: name, ref: "main" }, "srv");

    expect(refused).toEqual(missing);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.status).toBe("not_found");
  });

  it("lets anyone read a repository no team has claimed", () => {
    const { remote, work } = makeUpstream();
    const head = pushCommit(work, remote, "release", "shipped");
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote, teamId: null });

    // Unset is not "everyone's secret": every repository connected before
    // teams reached that table has no team, and reading them as forbidden
    // would make all of them unreachable with no way to tell which should be.
    const resolved = resolveAskSource({ question, repo: repo.repoId, ref: "release" }, "otherco");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source.commit).toBe(head);
  });
});

describe("a run as the source", () => {
  it("answers at the commit the run's publication was verified at, not where its branch now points", () => {
    const { remote, work } = makeUpstream();
    const published = pushCommit(work, remote, "gate/run-ask", "the work");
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote });
    const id = runIn(repo);
    setExecutionPublication(id, { ref: "refs/heads/gate/run-ask", commit: published, at: Date.now() });
    // Somebody pushed more onto the same branch afterwards.
    const later = pushCommit(work, remote, "gate/run-ask", "more, later");

    const resolved = resolveAskSource({ question, run: id }, "srv");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // A moving branch name is not a source. The run is answered from what the
    // remote confirmed when it published, so the same question asked twice
    // gets the same answer.
    expect(resolved.source.commit).toBe(published);
    expect(resolved.source.commit).not.toBe(later);
    expect(resolved.source.via).toBe("run");
  });

  it("names the run's branch to publish when it never published", () => {
    const { remote } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote });
    const id = runIn(repo, "desktop", "gate/run-unpublished");

    const resolved = resolveAskSource({ question, run: id }, "srv");
    expect(resolved.ok).toBe(false);
    if (resolved.ok || resolved.status !== "source_unavailable") return;
    expect(resolved.reason).toContain(id);
    // The branch that has to be published is the one this run made, not the
    // repository's default: telling somebody to publish the wrong branch is
    // the same as telling them nothing.
    expect(resolved.publish).toEqual({ repo: repo.id, ref: "gate/run-unpublished" });
  });

  it("repeats the last publish failure, so the reason says what to fix", () => {
    const { remote } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote });
    const id = runIn(repo);
    setExecutionPublication(id, { error: "remote rejected: protected branch" });

    const resolved = resolveAskSource({ question, run: id }, "srv");
    expect(resolved.ok).toBe(false);
    if (resolved.ok || resolved.status !== "source_unavailable") return;
    expect(resolved.reason).toContain("protected branch");
  });

  it("refuses a run outside the asker's family in the same words a missing one gets", () => {
    const { remote, work } = makeUpstream();
    const published = pushCommit(work, remote, "gate/run-ask", "the work");
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote, teamId: "otherco" });
    const id = runIn(repo, "otherco");
    setExecutionPublication(id, { ref: "refs/heads/gate/run-ask", commit: published, at: Date.now() });

    const refused = resolveAskSource({ question, run: id }, "srv");
    expect(deleteExecution(id)).toBe(true);
    const missing = resolveAskSource({ question, run: id }, "srv");

    // Knowing that a run with this id exists is already more than the asker is
    // owed about another company's work.
    expect(refused).toEqual(missing);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.status).toBe("not_found");
  });
});

describe("bringing the commit to this machine", () => {
  it("fetches a commit this gate's own checkout did not have", () => {
    const { remote, work } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote });
    // Pushed after the checkout was made, so this machine has never seen it.
    const head = pushCommit(work, remote, "later", "done after the clone");

    const resolved = resolveAskSource({ question, repo: repo.repoId, ref: "later" }, "srv");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source.commit).toBe(head);
    // Without this the test would pass on a checkout that already had the
    // commit, and prove nothing about fetching.
    expect(() => git(repo.root, "cat-file", "-e", `${head}^{commit}`)).toThrow();

    expect(fetchAskSource(resolved.source)).toEqual({ ok: true });
    expect(git(repo.root, "cat-file", "-e", `${head}^{commit}`)).toBe("");
  });

  it("reports a commit the remote will not give rather than throwing", () => {
    const { remote } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote });
    const absent = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    const resolved = resolveAskSource({ question, repo: repo.repoId, commit: absent }, "srv");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // git exits non-zero for a commit nobody has; an ask that threw here would
    // lose the question instead of answering that the source is not reachable.
    const fetched = fetchAskSource(resolved.source);
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.reason).toContain(absent.slice(0, 8));
  });
});

describe("what memory already knows at that commit", () => {
  /** A repository, a commit on main, and a decision on each of two branches. */
  function withDecisions(): { source: AskSource; onMain: string; onSidetrack: string } {
    const { remote, work } = makeUpstream();
    const ancestor = git(work, "rev-parse", "HEAD");
    const sidetrack = pushCommit(work, remote, "sidetrack", "never merged");
    git(work, "checkout", "-q", "main");
    pushCommit(work, remote, "main", "carried on");
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote, teamId: "srv" });

    const resolved = resolveAskSource({ question, repo: repo.repoId, ref: "main" }, "srv");
    if (!resolved.ok) throw new Error(`could not resolve the source: ${JSON.stringify(resolved)}`);

    for (const [head, title] of [
      [ancestor, "the handshake sends the key share in the first flight"],
      [sidetrack, "the handshake moves the key share to the second flight"],
    ]) {
      const id = `ask-mem-${++n}`;
      createExecution(id, "dev", {}, Date.now(), null, { teamId: "srv", repoId: repo.repoId });
      replaceDecisions(
        {
          executionId: id,
          teamId: "srv",
          userId: null,
          featureId: null,
          repoId: repo.repoId,
          baseCommit: null,
          headCommit: head,
          outcome: "completed",
          validFrom: Date.now(),
        },
        [{ title, context: "", decision: title, rationale: "", how: "", consequences: "", alternatives: "", touches: [] }],
      );
    }
    return { source: resolved.source, onMain: ancestor, onSidetrack: sidetrack };
  }

  it("counts a decision made on a commit in this one's history as covering it", async () => {
    const { source, onMain } = withDecisions();

    const coverage = await memoryAt(source, question, "srv");
    // What this commit's own history contains is what a reader of the code at
    // this commit would find, which is the only thing the answer may state
    // without qualification.
    expect(coverage.covering.map((d) => d.commits.head)).toEqual([onMain]);
  });

  it("keeps a decision from a branch this commit cannot see out of the covering set", async () => {
    const { source, onSidetrack } = withDecisions();

    const coverage = await memoryAt(source, question, "srv");
    // Recorded later than the covering one and about the same subject, so a
    // partition by date rather than by ancestry would put it the wrong side and
    // have the answer state an unmerged branch's decision as current fact.
    expect(coverage.elsewhere.map((d) => d.commits.head)).toContain(onSidetrack);
    expect(coverage.covering.map((d) => d.commits.head)).not.toContain(onSidetrack);
  });

  it("does not count a decision whose commit this checkout never fetched as covering", async () => {
    const { remote } = makeUpstream();
    const repo = connect({ root: makeCheckout(remote), publicationRemote: remote, teamId: "srv" });
    const resolved = resolveAskSource({ question, repo: repo.repoId, ref: "main" }, "srv");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const id = `ask-mem-${++n}`;
    createExecution(id, "dev", {}, Date.now(), null, { teamId: "srv", repoId: repo.repoId });
    replaceDecisions(
      {
        executionId: id,
        teamId: "srv",
        userId: null,
        featureId: null,
        repoId: repo.repoId,
        baseCommit: null,
        headCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        outcome: "completed",
        validFrom: Date.now(),
      },
      [
        {
          title: "the handshake was rewritten on a branch nobody pushed",
          context: "",
          decision: "rewritten",
          rationale: "",
          how: "",
          consequences: "",
          alternatives: "",
          touches: [],
        },
      ],
    );

    const coverage = await memoryAt(resolved.source, question, "srv");
    // git cannot answer whether an absent commit is an ancestor. Reading that
    // silence as "yes" is the one place unpublished work would be quoted back
    // as if it were in the code being asked about.
    expect(coverage.covering).toEqual([]);
    expect(coverage.elsewhere).toHaveLength(1);
  });
});
