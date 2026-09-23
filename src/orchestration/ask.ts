import { execFileSync } from "node:child_process";

import { getExecution } from "@/executions/store";
import { teamFamily } from "@/lib/teams";
import { LocalMemoryAccess, type DecisionCard, type IssueCard } from "@/memory/access";
import { getRepo, listRepos, repoByIdentity, type RepoRecord } from "@/repos/store";

/**
 * Asking another team what they did, and being answered from something.
 *
 * The case this exists for: the server team needs to know how desktop
 * handled a thing, and nobody on desktop is awake. The answer has to come
 * from somewhere that is true — a decision in memory, or the code itself —
 * and it has to say which. An answer that cannot name a commit is a guess
 * with a citation format.
 *
 * Three rules shape everything here.
 *
 * A moving branch name is not a source. Every answer resolves to one fixed
 * commit before anything reads anything, and that commit is quoted back, so
 * the same question asked twice either gives the same answer or says why the
 * source moved.
 *
 * Work that is not published is not reachable. A branch in a worktree on
 * somebody's laptop cannot be read from here however much gate knows about
 * it, and pretending otherwise is how "the feature was never built" gets
 * said about a feature that was built last Tuesday. Unreachable is its own
 * answer, with the branch that needs publishing named in it.
 *
 * The family is the boundary, and it is the same boundary memory uses. Being
 * able to read a sibling team's decisions is not permission to read a third
 * company's repository, and neither is knowing its name.
 */

export interface AskRequest {
  /** What is being asked, in the asker's words. */
  question: string;
  /** `host/owner/name`, or a connected repository's own id. */
  repo?: string | null;
  /** A run whose published branch is the thing being asked about. */
  run?: string | null;
  /** A branch or tag on the repository's publication remote. */
  ref?: string | null;
  /** An exact commit, when the asker already has one. */
  commit?: string | null;
}

/** A source resolved to something that can actually be read. */
export interface AskSource {
  repo: RepoRecord;
  /** `host/owner/name`, or null for a repository whose remote never said. */
  repoId: string | null;
  /** The team the source belongs to — already checked against the asker's. */
  teamId: string | null;
  /** What was asked for: a branch, a tag, a run's branch, or the commit itself. */
  ref: string;
  /** The fixed commit everything else is about. */
  commit: string;
  /** Where it was read from: the repository's publication remote. */
  remote: string;
  /** How the commit was arrived at, for the answer to quote. */
  via: "run" | "ref" | "commit";
}

export type AskResolution =
  | { ok: true; source: AskSource }
  | {
      ok: false;
      /** Always this: the question is answerable, the source is not reachable. */
      status: "source_unavailable";
      /** What would make it reachable, in the words of whoever has to do it. */
      reason: string;
      /** The branch somebody needs to publish, when that is the missing piece. */
      publish?: { repo: string; ref: string | null } | null;
    }
  | { ok: false; status: "forbidden"; reason: string }
  | { ok: false; status: "not_found"; reason: string };

const LS_REMOTE_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 10 * 60_000;

function git(cwd: string, args: string[], timeout = 60_000): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
}

function gitMessage(e: unknown): string {
  const err = e as Error & { stderr?: string };
  return (err.stderr || err.message || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * The repository being asked about, whichever way it was named.
 *
 * Both spellings are accepted because both are in front of people: the
 * canonical `host/owner/name` is what a decision carries, and the connected
 * id is what the Repos page shows. Neither is guessed from the other.
 */
function findRepo(name: string): RepoRecord | null {
  return repoByIdentity(name) ?? getRepo(name) ?? listRepos().find((r) => r.repoId === name) ?? null;
}

/** Whether the asker may read this repository at all. */
function withinFamily(repo: RepoRecord, askerTeamId: string): boolean {
  // A repository nobody has assigned a team to is readable by anyone who can
  // reach this gate. That is what it already was — the alternative, treating
  // "unset" as "everyone's secret", would make every repository connected
  // before teams reached that table unreadable, with no way to tell which
  // ones should have been.
  if (!repo.teamId) return true;
  return teamFamily(askerTeamId).includes(repo.teamId);
}

/**
 * Turns a repo/run/ref/commit into one commit, or says why it cannot.
 *
 * Nothing here reads a file. This is the step that decides *what* would be
 * read, and it is separate precisely so that "the source is not available" is
 * answered in a second rather than at the end of a review that had nothing to
 * review.
 */
export function resolveAskSource(req: AskRequest, askerTeamId: string): AskResolution {
  const run = req.run?.trim();
  if (run) return fromRun(run, askerTeamId);

  const name = req.repo?.trim();
  if (!name) {
    return { ok: false, status: "not_found", reason: "say which repository to read: --repo <host/owner/name>, or --run <id>" };
  }
  const repo = findRepo(name);
  if (!repo) {
    return { ok: false, status: "not_found", reason: `gate has no repository called "${name}"` };
  }
  if (!withinFamily(repo, askerTeamId)) {
    // Deliberately the same words a missing repository gets. Which
    // repositories another company has is not something to confirm by the
    // shape of a refusal.
    return { ok: false, status: "not_found", reason: `gate has no repository called "${name}"` };
  }
  const remote = repo.publicationRemote?.trim();
  if (!remote) {
    return {
      ok: false,
      status: "source_unavailable",
      reason: `"${repo.id}" does not publish, so nothing in it can be read from here — give it a publication remote on the Repos page`,
      publish: { repo: repo.id, ref: req.ref?.trim() || null },
    };
  }

  const commit = req.commit?.trim();
  if (commit) {
    if (!SHA.test(commit)) return { ok: false, status: "not_found", reason: `"${commit}" is not a commit` };
    return { ok: true, source: { repo, repoId: repo.repoId, teamId: repo.teamId, ref: commit, commit, remote, via: "commit" } };
  }

  const ref = req.ref?.trim() || repo.baseRef?.trim() || "HEAD";
  const resolved = resolveRemoteRef(repo, remote, ref);
  if (!resolved.ok) return resolved;
  return { ok: true, source: { repo, repoId: repo.repoId, teamId: repo.teamId, ref, commit: resolved.commit, remote, via: "ref" } };
}

/**
 * A run names its source better than a branch does: gate verified what the
 * remote held after it pushed, and recorded that commit. So a run that
 * published is answered from the commit the remote confirmed, not from
 * whatever its branch points at now.
 */
function fromRun(executionId: string, askerTeamId: string): AskResolution {
  const execution = getExecution(executionId);
  if (!execution) return { ok: false, status: "not_found", reason: `no run "${executionId}"` };
  if (!teamFamily(askerTeamId).includes(execution.teamId)) {
    return { ok: false, status: "not_found", reason: `no run "${executionId}"` };
  }
  const repo = execution.repoId ? repoByIdentity(execution.repoId) : null;
  if (!repo) {
    return {
      ok: false,
      status: "source_unavailable",
      reason: `run ${executionId} worked in a repository this gate has no record of, so its branch cannot be reached`,
      publish: null,
    };
  }
  const branch = execution.workspace?.branch ?? null;
  if (!execution.publishedCommit) {
    return {
      ok: false,
      status: "source_unavailable",
      // The run may well have done the work. Saying so is the difference
      // between "publish this branch" and the answer that starts an argument.
      reason:
        `run ${executionId} has not published its branch, so its work is only on the machine that did it` +
        (execution.publishError ? ` (the last attempt failed: ${execution.publishError})` : ""),
      publish: { repo: repo.id, ref: branch },
    };
  }
  const remote = repo.publicationRemote?.trim();
  if (!remote) {
    return {
      ok: false,
      status: "source_unavailable",
      reason: `"${repo.id}" no longer names a publication remote, so the commit run ${executionId} published cannot be fetched`,
      publish: { repo: repo.id, ref: branch },
    };
  }
  return {
    ok: true,
    source: {
      repo,
      repoId: repo.repoId,
      teamId: repo.teamId,
      ref: execution.publishedRef ?? branch ?? execution.publishedCommit,
      commit: execution.publishedCommit,
      remote,
      via: "run",
    },
  };
}

function resolveRemoteRef(
  repo: RepoRecord,
  remote: string,
  ref: string,
): { ok: true; commit: string } | Extract<AskResolution, { ok: false }> {
  let out = "";
  try {
    out = git(repo.root, ["ls-remote", remote, ref], LS_REMOTE_TIMEOUT_MS);
  } catch (e) {
    return {
      ok: false,
      status: "source_unavailable",
      reason: `could not read ${remote} for "${repo.id}": ${gitMessage(e)}`,
      publish: null,
    };
  }
  const commit = out.split(/\s+/)[0] ?? "";
  if (!SHA.test(commit)) {
    return {
      ok: false,
      status: "source_unavailable",
      // The distinction the whole feature turns on: the ref is not there, and
      // that says nothing at all about whether the work exists.
      reason: `${remote} has no "${ref}" — the work may exist without having been published to it`,
      publish: { repo: repo.id, ref },
    };
  }
  return { ok: true, commit };
}

/**
 * Brings the commit into the server's own checkout, so a worktree can be cut
 * at it.
 *
 * Four teams do not mean four clones here, and the plan never assumed them:
 * what gate has is whatever repositories are connected to *this* gate, and
 * the fetch is what turns "the remote has it" into "this machine has it".
 * Fetched by commit where the server allows it, by ref otherwise — an older
 * or locked-down git refuses `fetch <sha>`, and the ref it came from is
 * always known.
 */
export function fetchAskSource(source: AskSource): { ok: true } | { ok: false; reason: string } {
  for (const spec of source.via === "commit" ? [source.commit] : [source.ref, source.commit]) {
    try {
      git(source.repo.root, ["fetch", "--no-tags", source.remote, spec], FETCH_TIMEOUT_MS);
      git(source.repo.root, ["cat-file", "-e", `${source.commit}^{commit}`]);
      return { ok: true };
    } catch {
      // Try the other spelling before giving up on the commit entirely.
    }
  }
  return {
    ok: false,
    reason: `${source.remote} would not give this gate ${source.commit.slice(0, 8)} for "${source.repo.id}"`,
  };
}

/** What memory already knows, split by whether it is true of the commit asked about. */
export interface MemoryCoverage {
  /** Decisions whose work is in this commit's history: they hold here. */
  covering: DecisionCard[];
  /**
   * Decisions about this repository that were made somewhere this commit
   * cannot see — a later branch, an unmerged one, or work that never reached
   * it. Shown with their own commit named, never folded into the answer.
   */
  elsewhere: DecisionCard[];
  /** Objections standing against any of them, from anywhere in the family. */
  issues: IssueCard[];
}

/**
 * Whether a decision is true of the commit being asked about.
 *
 * `merge-base --is-ancestor` and not a date: a decision recorded yesterday on
 * a branch that was never merged is not a fact about this commit, and one
 * recorded last year that is in its history is. The question is what this
 * commit's own history contains, which is the only thing a reader of the code
 * at that commit would find.
 *
 * A decision whose commit this checkout does not have is not covering: it is
 * on work nobody published, and this is the one place that must not quietly
 * treat unpublished work as readable.
 */
function holdsAt(root: string, decisionHead: string | null, commit: string): boolean {
  if (!decisionHead || !SHA.test(decisionHead)) return false;
  try {
    git(root, ["merge-base", "--is-ancestor", decisionHead, commit]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Memory read at one commit.
 *
 * Read in the *asker's* scope, not the source team's: the family is what
 * decides which decisions a team may see, and asking about another team's
 * repository must not widen it. The repository narrows it further — the same
 * relative path means different things in different repositories, and that is
 * exactly the confusion this is here to avoid.
 */
export async function memoryAt(source: AskSource, question: string, askerTeamId: string): Promise<MemoryCoverage> {
  const access = new LocalMemoryAccess(askerTeamId, source.repoId);
  const found = await access.search({ query: question, repoId: source.repoId, limit: 10 });
  const covering: DecisionCard[] = [];
  const elsewhere: DecisionCard[] = [];
  // A question in words reads the whole tree; what is true of this commit
  // is only ever this repository's.
  for (const decision of found.decisions.filter((d) => !d.repo || !source.repoId || d.repo === source.repoId)) {
    (holdsAt(source.repo.root, decision.commits.head, source.commit) ? covering : elsewhere).push(decision);
  }
  return { covering, elsewhere, issues: found.issues };
}
