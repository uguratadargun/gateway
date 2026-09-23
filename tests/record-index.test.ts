import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createExecution, setExecutionWorkspace } from "@/executions/store";
import { createTeam, teamAncestors } from "@/lib/teams";
import { LocalMemoryAccess } from "@/memory/access";
import { describeSearch } from "@/memory/cards";
import {
  designDocsOf,
  documentsLine,
  historyOf,
  indexRepo,
  interfaceUsers,
  parseInterfaces,
  parseRecordDoc,
  repoRecordFor,
  searchRecordDocs,
} from "@/memory/record-index";
import { getDecision, getFeature, memoryScopeFor, replaceDecisions, searchDecisions } from "@/memory/store";
import { createRepo, type RepoRecord } from "@/repos/store";

/**
 * The record index against real repositories.
 *
 * Everything the index claims is a fact about a base branch — which documents
 * are on it, which work landed in it, which files are gone from it — so these
 * build the branch with git and let git say. A fake would agree with whatever
 * the index assumed; the failures worth catching are disagreements with git.
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

function commit(root: string, message: string, body?: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message, ...(body ? ["-m", body] : []));
  return git(root, "rev-parse", "HEAD");
}

const DESIGN = `# Offline sync

## Summary
Edits made without a connection are kept and sent when it returns. The server's version number wins a conflict.

## How it works
A local queue, drained in order.

## Interfaces
- provides: \`POST /v1/sync\` — the batch endpoint every client pushes to
- consumes: sync.accepted event — clears the local queue

## Key files
- \`app/sync/Queue.kt\` — the queue

## Pitfalls
- Device clocks lie.

## Decisions
- none yet
`;

function decisionRecord(n: string, title: string, status = "accepted"): string {
  return `# ${n}. ${title}

Status: ${status}
Date: 2026-09-01
Run: manual

## Context
Before.

## Decision
${title}, because the clocks lie.

## Rationale
Why.

## Alternatives
None.

## How it works
Like so.

## Consequences
Some.

## Touches
- \`app/sync/merge.kt\`

## Supersedes
none
`;
}

function tree(): void {
  if (!teamAncestors("ri-ulak").length) {
    createTeam("RI Ulak", "ri-ulak");
    createTeam("RI Android", "ri-android", "ri-ulak");
    createTeam("RI Desktop", "ri-desktop", "ri-ulak");
    createTeam("RI Elsewhere", "ri-elsewhere");
  }
}

let n = 0;

/** A repository somebody works in: a working clone, its bare remote, and this gate's own checkout of it. */
function makeRepo(teamId = "ri-android"): { work: string; remote: string; repo: RepoRecord } {
  tree();
  const work = temp("gate-ri-work-");
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "T");
  write(work, "README.md", "hello\n");
  write(work, "app/sync/merge.kt", "// merge\n");
  write(work, "app/sync/Queue.kt", "// queue\n");
  write(work, "docs/design/offline-sync.md", DESIGN);
  write(work, "docs/decisions/0001-server-version-wins.md", decisionRecord("0001", "Server version wins a conflict"));
  commit(work, "init", "Documents: docs/design/offline-sync.md, docs/decisions/0001-server-version-wins.md");
  const remote = temp("gate-ri-remote-");
  git(remote, "init", "-q", "--bare");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
  const checkout = temp("gate-ri-checkout-");
  git(checkout, "clone", "-q", remote, checkout);
  const id = `ri-repo-${++n}`;
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
    teamId,
  });
  return { work, remote, repo };
}

function push(work: string): void {
  git(work, "push", "-q", "origin", "HEAD:main");
}

function draft(d: { title: string; touches: string[] }) {
  return {
    context: "",
    decision: d.title,
    rationale: "",
    alternatives: "",
    how: "",
    consequences: "",
    title: d.title,
    touches: d.touches.map((ref) => ({ kind: "file" as const, ref })),
  };
}

/** A run of android's that recorded one decision about this repository. */
function recordRun(
  repo: RepoRecord,
  o: { outcome: "pr-open" | "abandoned" | "merged" | "completed"; base?: string | null; head?: string | null; touches: string[]; verdict?: "rejected" },
): string {
  const executionId = `ri-run-${++n}`;
  createExecution(executionId, "dev", { task: "sync" }, Date.now(), null, { teamId: "ri-android", repoId: repo.repoId });
  const [d] = replaceDecisions(
    {
      executionId,
      teamId: "ri-android",
      userId: null,
      featureId: null,
      repoId: repo.repoId,
      baseCommit: o.base ?? null,
      headCommit: o.head ?? null,
      outcome: o.outcome,
      validFrom: 1_000,
    },
    [{ ...draft({ title: `decision of ${executionId}`, touches: o.touches }), verdict: o.verdict ?? null }],
  );
  return d.id;
}

describe("reading a record document", () => {
  it("takes a decision record's number, title, status and decision", () => {
    const doc = parseRecordDoc("docs/decisions/0007-a-thing.md", decisionRecord("0007", "A thing", "superseded by 0009"))!;
    expect(doc).toMatchObject({ kind: "decision", slug: "a-thing", number: 7, title: "A thing", status: "superseded by 0009", date: "2026-09-01" });
    expect(doc.summary).toContain("A thing, because the clocks lie.");
  });

  it("takes a design doc's summary and the interfaces it lists", () => {
    const doc = parseRecordDoc("docs/design/offline-sync.md", DESIGN)!;
    expect(doc.kind).toBe("design");
    expect(doc.summary).toContain("server's version number wins");
    expect(doc.interfaces).toEqual([
      { role: "provides", name: "POST /v1/sync", note: "the batch endpoint every client pushes to" },
      { role: "consumes", name: "sync.accepted event", note: "clears the local queue" },
    ]);
  });

  it("reads interface lines however they are emphasised, and ignores the rest", () => {
    expect(parseInterfaces("- **provides**: `GET /x` — reads x\n- consumes: queue.y\n- something else\n* Provides: GET /x — twice")).toEqual([
      { role: "provides", name: "GET /x", note: "reads x" },
      { role: "consumes", name: "queue.y", note: "" },
    ]);
  });

  it("reads other writing under docs/ as a note, and never the plans or a misnamed record", () => {
    expect(parseRecordDoc("docs/plans/2026-09-01-x.md", "# x")).toBeNull();
    expect(parseRecordDoc("docs/decisions/notes.md", "# x")).toBeNull();
    expect(parseRecordDoc("docs/design/sub/x.md", "# x")).toBeNull();
    const note = parseRecordDoc("docs/superpowers/specs/2026-06-10-ptt-invite-removal-design.md", "# PTT invite removal\n\nThe invite goes; the call stays.\n")!;
    expect(note).toMatchObject({ kind: "note", slug: "2026-06-10-ptt-invite-removal-design", title: "PTT invite removal", date: "2026-06-10" });
    expect(note.summary).toBe("The invite goes; the call stays.");
    expect(parseRecordDoc("docs/specs/2026-09-01-thing.md", "Status: done\n\n# Thing\n\nWhat it did.")?.date).toBe("2026-09-01");
    expect(parseRecordDoc("README.md", "# x")).toBeNull();
  });

  it("keeps a design doc's pitfalls apart from its summary", () => {
    expect(parseRecordDoc("docs/design/offline-sync.md", DESIGN)!.pitfalls).toBe("- Device clocks lie.");
    expect(parseRecordDoc("docs/decisions/0001-a.md", decisionRecord("0001", "A"))!.pitfalls).toBe("");
  });

  it("reads the Documents line of a commit body", () => {
    expect(documentsLine("Why.\n\nDocuments: docs/decisions/0007-x.md, docs/design/sync.md\n")).toEqual(["docs/decisions/0007-x.md", "docs/design/sync.md"]);
    expect(documentsLine("no record here")).toEqual([]);
  });
});

describe("the record index", () => {
  it("reads a repository's documents from its base branch and opens its feature in the tree's catalogue", async () => {
    const { repo } = makeRepo();
    const out = await indexRepo(repo);
    expect(out.ok).toBe(true);
    expect(out.read).toBe(2);

    // The design doc's file name is the feature's id, in the root's catalogue.
    const feature = getFeature("offline-sync");
    expect(feature?.orgId).toBe("ri-ulak");

    // A sibling team reads it by words, with the repository and commit it came from.
    const desktop = memoryScopeFor("ri-desktop");
    const hits = searchRecordDocs(desktop, { query: "conflict version number" });
    expect(hits.map((h) => h.path)).toEqual(expect.arrayContaining(["docs/design/offline-sync.md", "docs/decisions/0001-server-version-wins.md"]));
    expect(hits[0].commit).toBe(out.commit);

    // Another company's tree does not.
    expect(searchRecordDocs(memoryScopeFor("ri-elsewhere"), { query: "conflict version number" })).toEqual([]);

    // The feature's page carries every repository's design doc with its interfaces.
    const docs = designDocsOf(desktop, "offline-sync");
    expect(docs.some((d) => d.repo === repo.id && d.interfaces.some((i) => i.name === "POST /v1/sync"))).toBe(true);
    expect(interfaceUsers(desktop, "/v1/sync").map((i) => i.role)).toContain("provides");
  });

  it("reads a document again only when it changed, and forgets one that was deleted", async () => {
    const { work, repo } = makeRepo();
    await indexRepo(repo);
    const again = await indexRepo(repo);
    expect(again.read).toBe(0);

    write(work, "docs/design/offline-sync.md", DESIGN.replace("Device clocks lie.", "Device clocks lie, always."));
    rmSync(join(work, "docs/decisions/0001-server-version-wins.md"));
    commit(work, "edit");
    push(work);
    const third = await indexRepo(repo);
    expect(third.read).toBe(1);
    expect(third.removed).toBe(1);
    expect(searchRecordDocs(memoryScopeFor("ri-android"), { query: "server version wins" }).some((d) => d.repo === repo.id && d.kind === "decision")).toBe(false);
  });

  it("promotes a decision whose work reached the base branch to merged, and leaves the rest", async () => {
    const { work, repo } = makeRepo();
    const base = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-q", "-b", "gate/run-landed");
    write(work, "app/sync/retry.kt", "// retry\n");
    const landedHead = commit(work, "retry");
    git(work, "checkout", "-q", "-b", "gate/run-open", base);
    write(work, "app/sync/other.kt", "// other\n");
    const openHead = commit(work, "other");
    git(work, "checkout", "-q", "main");
    git(work, "merge", "-q", "--no-ff", "gate/run-landed", "-m", "Merge gate/run-landed");
    push(work);

    // Stopped before its merge request — and merged by hand anyway.
    const landed = recordRun(repo, { outcome: "abandoned", base, head: landedHead, touches: ["app/sync/retry.kt"] });
    const open = recordRun(repo, { outcome: "pr-open", base, head: openHead, touches: ["app/sync/other.kt"] });
    // Changed nothing: its head is its base, which is trivially in the history.
    const readOnly = recordRun(repo, { outcome: "completed", base, head: base, touches: [] });
    // Refused: the branch landing is the final version, not this attempt.
    const refused = recordRun(repo, { outcome: "abandoned", base, head: landedHead, touches: ["app/sync/retry.kt"], verdict: "rejected" });

    const out = await indexRepo(repo);
    expect(out.merged).toBe(1);
    expect(getDecision(landed)!.outcome).toBe("merged");
    expect(getDecision(open)!.outcome).toBe("pr-open");
    expect(getDecision(readOnly)!.outcome).toBe("completed");
    expect(getDecision(refused)!.outcome).toBe("abandoned");
  });

  it("finds a squash merge by the decision record the run wrote", async () => {
    const { work, repo } = makeRepo();
    write(work, "docs/decisions/0002-queue-in-order.md", decisionRecord("0002", "The queue drains in order"));
    commit(work, "squashed: queue in order");
    push(work);
    // The run's own head was never pushed anywhere this checkout can see.
    const d = recordRun(repo, { outcome: "pr-open", base: "1".repeat(40), head: "2".repeat(40), touches: ["docs/decisions/0002-queue-in-order.md"] });
    await indexRepo(repo);
    expect(getDecision(d)!.outcome).toBe("merged");
  });

  it("follows a decision record renumbered on the base branch, and closes decisions whose record was superseded", async () => {
    const { work, repo } = makeRepo();
    // The run wrote 0002, another branch merged a 0002 first, and this one
    // landed as 0003 — memory still says 0002.
    write(work, "docs/decisions/0002-something-else.md", decisionRecord("0002", "Something else"));
    write(work, "docs/decisions/0003-retry-with-backoff.md", decisionRecord("0003", "Retry with backoff"));
    write(work, "docs/decisions/0001-server-version-wins.md", decisionRecord("0001", "Server version wins a conflict", "superseded by 0003"));
    commit(work, "renumbered");
    push(work);
    const renumbered = recordRun(repo, { outcome: "merged", touches: ["docs/decisions/0002-retry-with-backoff.md", "app/sync/merge.kt"] });
    const fromOld = recordRun(repo, { outcome: "merged", touches: ["docs/decisions/0001-server-version-wins.md"] });

    const out = await indexRepo(repo);
    expect(out.renamed).toBe(1);
    expect(getDecision(renumbered)!.touches.map((t) => t.ref)).toContain("docs/decisions/0003-retry-with-backoff.md");
    const byPath = searchDecisions(memoryScopeFor("ri-android"), { paths: ["docs/decisions/0003-retry-with-backoff.md"], repoId: repo.repoId });
    expect(byPath.map((d) => d.id)).toContain(renumbered);
    expect(getDecision(fromOld)!.validTo).not.toBeNull();
  });

  it("marks a shipped decision whose every file is gone, and only that", async () => {
    const { work, repo } = makeRepo();
    const gone = recordRun(repo, { outcome: "merged", touches: ["app/sync/merge.kt"] });
    const partly = recordRun(repo, { outcome: "merged", touches: ["app/sync/merge.kt", "app/sync/Queue.kt"] });
    const dir = recordRun(repo, { outcome: "merged", touches: ["app/sync"] });
    // Not landed: its new files are not on the base branch yet, and not missing.
    const open = recordRun(repo, { outcome: "pr-open", head: "3".repeat(40), touches: ["app/sync/new.kt"] });
    rmSync(join(work, "app/sync/merge.kt"));
    commit(work, "remove merge");
    push(work);

    const out = await indexRepo(repo);
    expect(out.stale).toBe(1);
    expect(getDecision(gone)!.missingTouches).toBe(1);
    expect(getDecision(partly)!.missingTouches).toBe(1);
    expect(getDecision(dir)!.missingTouches).toBe(0);
    expect(getDecision(open)!.checkedCommit).toBeNull();

    const card = (await new LocalMemoryAccess("ri-android").search({ paths: ["app/sync/merge.kt"] })).decisions.find((d) => d.id === gone)!;
    expect(card.checked?.allGone).toBe(true);
  });

  it("gives a path's history on the base branch, each commit with its record, a person's commits too", async () => {
    const { work, repo } = makeRepo();
    write(work, "app/sync/merge.kt", "// merge, fixed\n");
    commit(work, "fix(sync): merge keeps the server's version", "Documents: docs/decisions/0001-server-version-wins.md");
    write(work, "README.md", "unrelated\n");
    commit(work, "docs: readme");
    push(work);
    await indexRepo(repo);
    const h = await historyOf(memoryScopeFor("ri-desktop"), { repoId: repo.repoId, paths: ["app/sync"] });
    expect(h.unavailable).toBeNull();
    expect(h.commits.map((c) => c.subject)).toEqual(["fix(sync): merge keeps the server's version", "init"]);
    expect(h.commits[0].documents).toEqual(["docs/decisions/0001-server-version-wins.md"]);

    const elsewhere = await historyOf(memoryScopeFor("ri-elsewhere"), { repoId: repo.repoId, paths: ["app/sync"] });
    expect(elsewhere.commits).toEqual([]);
    expect(elsewhere.unavailable).toContain("no repository");
  });

  it("reaches recall: a sibling team's search carries the repository's own record", async () => {
    const { repo } = makeRepo();
    await indexRepo(repo);
    const result = await new LocalMemoryAccess("ri-desktop").search({ query: "offline sync conflict" });
    expect(result.documents?.some((d) => d.repo === repo.id && d.path === "docs/design/offline-sync.md")).toBe(true);
    expect(describeSearch(result)).toContain("The repositories' own record");
    const withInterface = await new LocalMemoryAccess("ri-desktop").search({ query: "change POST /v1/sync to accept batches" });
    expect(withInterface.interfaces?.some((i) => i.name === "POST /v1/sync" && i.role === "provides")).toBe(true);
    const detail = await new LocalMemoryAccess("ri-desktop").feature("offline-sync");
    expect(detail?.documents?.some((d) => d.repo === repo.id)).toBe(true);
    expect(detail?.feature.teams).toContain("ri-android");
  });

  it("reads a repository's writing from before the convention, as notes a sibling finds", async () => {
    const { work, repo } = makeRepo();
    write(work, "docs/mention-system.md", "# Mention system\n\nAn @ opens a picker of the group's members; the choice is stored as a user id, not a name.\n");
    write(work, "docs/plans/2026-09-01-scratch.md", "# Scratch mention picker\n");
    commit(work, "notes");
    push(work);
    await indexRepo(repo);
    const hits = searchRecordDocs(memoryScopeFor("ri-desktop"), { query: "mention picker members" });
    const note = hits.find((h) => h.repo === repo.id && h.path === "docs/mention-system.md");
    expect(note?.kind).toBe("note");
    expect(hits.some((h) => h.path.startsWith("docs/plans/"))).toBe(false);
    // A note is never a feature's page.
    expect(getFeature("mention-system")).toBeNull();
    const detail = await new LocalMemoryAccess("ri-desktop").feature("offline-sync");
    expect(detail?.documents?.find((d) => d.repo === repo.id)?.pitfalls).toContain("Device clocks lie.");
  });

  it("tells a checkout whether the gate reads it, within the family only", async () => {
    const { repo } = makeRepo();
    await indexRepo(repo);
    const mine = repoRecordFor(memoryScopeFor("ri-desktop"), repo.repoId);
    expect(mine).toMatchObject({ connected: true, repo: repo.id, team: "ri-android", ref: "main" });
    expect(mine.documents).toMatchObject({ design: 1, decision: 1 });
    expect(repoRecordFor(memoryScopeFor("ri-elsewhere"), repo.repoId).connected).toBe(false);
    expect(repoRecordFor(memoryScopeFor("ri-desktop"), "github.com/nobody/nothing")).toMatchObject({ connected: false });
    expect(repoRecordFor(memoryScopeFor("ri-desktop"), null).advice).toContain("no remote");
  });

  it("says what went wrong when the checkout is not there, and does not throw", async () => {
    tree();
    const repo = createRepo({
      id: `ri-missing-${++n}`,
      name: "missing",
      source: "/nonexistent",
      root: "/nonexistent/checkout",
      cloned: false,
      baseRef: null,
      setup: [],
      prepare: [],
      teamId: "ri-android",
    });
    const out = await indexRepo(repo);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not on this machine");
  });
});

describe("a run's own work in a repository it records", () => {
  it("keeps the run's workspace and published commit as ways its work is known", async () => {
    const { work, repo } = makeRepo();
    const base = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-q", "-b", "gate/run-published");
    write(work, "app/sync/p.kt", "// p\n");
    const published = commit(work, "p");
    git(work, "checkout", "-q", "main");
    git(work, "merge", "-q", "--ff-only", "gate/run-published");
    push(work);
    // The run's head is unknown; what it published is.
    const id = recordRun(repo, { outcome: "pr-open", base, head: null, touches: ["app/sync/p.kt"] });
    const executionId = getDecision(id)!.executionId;
    setExecutionWorkspace(executionId, { root: repo.root, repo: repo.id, branch: "gate/run-published", baseRef: "main", commit: null, changedFiles: [] });
    const { getDb } = await import("@/lib/db");
    getDb().prepare("UPDATE workflow_executions SET published_commit = ? WHERE id = ?").run(published, executionId);
    await indexRepo(repo);
    expect(getDecision(id)!.outcome).toBe("merged");
  });
});
