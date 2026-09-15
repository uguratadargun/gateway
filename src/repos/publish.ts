import { execFileSync } from "node:child_process";

/**
 * Making a run's work reachable from another machine.
 *
 * A branch in a checkout on somebody's laptop is not a deliverable to anyone
 * but that person. The whole cross-team case depends on the opposite: the
 * server team asks what the desktop team did, and nobody on desktop is awake
 * to answer. Either the work is on a remote or the answer is a guess.
 *
 * This is deliberately a separate step from the run, from the diff and from
 * the memory record. A publication can fail — no network, no permission, a
 * protected branch — and when it does, the run's result is untouched and the
 * failure is reported as itself. Development succeeding and publication
 * failing is an ordinary combination, not a contradiction.
 *
 * No git configuration is written and nothing is forced: gate pushes a branch
 * it created to a ref under its own prefix, and that is all.
 */

export interface PublicationTarget {
  /**
   * What `git push` is given: a remote name the checkout already has, or a
   * URL. A name is preferred — it carries the credentials git is configured
   * with, and a URL in the database is one more copy of a secret's address.
   */
  remote: string;
  /**
   * Which branches may be published, as a glob. A run's branch is `gate/…`
   * by construction, so the default policy publishes exactly what gate made
   * and nothing a person is working on. `**` means anything; empty means
   * nothing, and is how a repository says "never push from here".
   */
  branchPolicy: string;
}

/** A publication that was verified afterwards against the remote itself. */
export interface Published {
  /** The full ref on the remote, so there is no ambiguity about what moved. */
  ref: string;
  /** What the remote reported holding *after* the push — not what was sent. */
  commit: string;
  at: number;
}

export type PublishOutcome =
  | { ok: true; published: Published; note: string }
  | { ok: false; code: PublishFailure; note: string };

export type PublishFailure =
  /** The repository names no publication target; nothing was attempted. */
  | "no-target"
  /** The branch is not one this repository allows to be published. */
  | "policy"
  /** git refused the push; its own words are in the note. */
  | "push-failed"
  /** The push reported success and the remote does not have the commit. */
  | "not-verified";

const PUSH_TIMEOUT_MS = 5 * 60_000;

export const DEFAULT_BRANCH_POLICY = "gate/*";

/**
 * Whether a branch is one this repository publishes.
 *
 * A glob rather than a prefix because the interesting policies are shapes:
 * `gate/*` is everything gate makes, `gate/postquantum-*` is one task's
 * branches, `**` is a repository that publishes whatever it is given.
 *
 * `*` does not cross `/` — `gate/*` is a promise that a branch two levels down
 * is not swept up by accident — and `**` does. A policy of exactly `*` is read
 * as `**`, because the one thing it cannot have meant is what it would
 * otherwise say: every branch gate makes has a slash in it, so "publish
 * anything" typed as `*` would have quietly published nothing at all.
 */
export function branchAllowed(branch: string, policy: string): boolean {
  const p = policy.trim() === "*" ? "**" : policy.trim();
  if (!p) return false;
  const pattern = p
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? "[\\s\\S]*" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${pattern}$`).test(branch);
}

function git(cwd: string, args: string[], timeout = 30_000): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
}

function gitMessage(e: unknown): string {
  const err = e as Error & { stderr?: string };
  return (err.stderr || err.message || "").trim().split("\n").slice(-3).join(" ").slice(0, 400);
}

/**
 * Pushes a run's branch to the repository's publication target, then asks the
 * remote what it actually has.
 *
 * The verification is the point. A push that "succeeded" against a remote
 * that quietly rewrote or rejected the ref would leave gate recording a
 * commit nobody else can fetch, and the next team's question would be
 * answered from a commit that does not exist for them. So the commit that is
 * recorded is the one `ls-remote` reports afterwards, never the local HEAD.
 *
 * `HEAD:refs/heads/<branch>` and no `--force`: a non-fast-forward is a
 * refusal, not something to resolve from here. No `--set-upstream` either —
 * an upstream changes what `gate clean` thinks a worktree is, and a
 * publication should not quietly make a worktree disposable.
 */
export function publishBranch(root: string, branch: string, target: PublicationTarget | null): PublishOutcome {
  if (!target?.remote.trim()) {
    return { ok: false, code: "no-target", note: "this repository has no publication remote, so the branch stays local" };
  }
  if (!branchAllowed(branch, target.branchPolicy)) {
    return {
      ok: false,
      code: "policy",
      note: `branch ${branch} is outside what this repository publishes (${target.branchPolicy || "nothing"})`,
    };
  }

  const ref = `refs/heads/${branch}`;
  try {
    git(root, ["push", target.remote, `HEAD:${ref}`], PUSH_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, code: "push-failed", note: `could not publish ${branch} to ${target.remote}: ${gitMessage(e)}` };
  }

  let remoteSha = "";
  try {
    // `ls-remote` rather than a local ref: the local remote-tracking ref is
    // written by the push itself and would agree with it by construction.
    remoteSha = git(root, ["ls-remote", target.remote, ref]).split(/\s+/)[0] ?? "";
  } catch (e) {
    return { ok: false, code: "not-verified", note: `${branch} was pushed to ${target.remote} but could not be read back: ${gitMessage(e)}` };
  }
  if (!/^[0-9a-f]{7,40}$/.test(remoteSha)) {
    return { ok: false, code: "not-verified", note: `${target.remote} does not report holding ${ref} after the push` };
  }

  return {
    ok: true,
    published: { ref, commit: remoteSha, at: Date.now() },
    note: `published ${branch} to ${target.remote} at ${remoteSha.slice(0, 8)}`,
  };
}

/**
 * Commits whatever is in the worktree as a checkpoint, so work that is not
 * finished can still be published.
 *
 * Publishing only at the end of a run does not meet the need it exists for:
 * the postquantum case is a question about work still in progress, and a
 * branch that gets its first commit when the run ends is invisible for the
 * whole time the question is being asked. A checkpoint is explicit — someone
 * or something asked for it — and says so in its message, so nobody reads it
 * as a finished piece of work.
 *
 * Returns the commit, or null when there was nothing to commit.
 */
export function checkpointWork(root: string, note: string, exclude: readonly string[] = []): string | null {
  if (!git(root, ["status", "--porcelain"]).length) return null;
  git(root, ["add", "-A", "--", ".", ...exclude.map((d) => `:(exclude)${d}`)]);
  if (!git(root, ["diff", "--cached", "--name-only"]).length) return null;
  let identity: string[] = [];
  try {
    git(root, ["config", "user.email"]);
  } catch {
    identity = ["-c", "user.name=gate", "-c", "user.email=gate@localhost"];
  }
  // Hooks skipped for the same reason the end-of-run commit skips them: this
  // is a snapshot of work in progress, and a pre-commit lint has no business
  // deciding whether unfinished work may be seen.
  git(root, [...identity, "commit", "--no-verify", "-q", "-m", `gate checkpoint: ${note}`]);
  return git(root, ["rev-parse", "HEAD"]);
}
