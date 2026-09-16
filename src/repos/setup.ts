import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { WorkflowError } from "@/runtime/errors";
import { readRemoteUrl } from "@/runtime/workspace";

import { detectRepoCommands, linkedDirectories, type RepoCommands } from "./detect";
import { canonicalRepoId } from "./identity";
import { getRepo, listRepos, setRepoRemote, setRepoStatus, type RepoRecord } from "./store";

/**
 * Connecting a repository, and getting it into a state a run can work in.
 *
 * The clone and the install happen once, here, rather than inside a pipeline:
 * every workflow pointed at the same project was otherwise carrying its own
 * copy of the same three command nodes, and getting them subtly wrong.
 */

const CLONE_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 30 * 60_000;
/** A log nobody will read past is a log that should not be kept whole. */
const MAX_LOG_BYTES = 200_000;

export function reposDir(): string {
  return join(process.env.GATE_HOME || join(homedir(), ".gate"), "repos");
}

function looksLikeUrl(source: string): boolean {
  return /^(https?|ssh|git):\/\//.test(source) || /^[\w.-]+@[\w.-]+:/.test(source);
}

/** A slug that is safe as a directory name, a URL segment and a run input. */
export function slugFor(source: string): string {
  const tail = source.replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
  const slug = tail
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "repo";
}

export interface ConnectResult {
  root: string;
  cloned: boolean;
  commands: RepoCommands;
  /** What the checkout's origin says, or null when it has none. */
  remoteUrl: string | null;
}

/**
 * Resolve a source to a checkout on disk, cloning if it is a URL.
 *
 * Credentials are deliberately not gate's business: a clone runs as the user,
 * so it uses the same git config, SSH agent and credential helper the shell
 * would. Anything private that works in a terminal works here, and anything
 * that does not fails with git's own message rather than one gate invented.
 */
export function connectRepo(source: string, id: string): ConnectResult {
  const trimmed = source.trim();
  if (!trimmed) throw new WorkflowError("WORKSPACE_ERROR", "give a repository path or a git URL");

  if (looksLikeUrl(trimmed)) {
    const root = join(reposDir(), id);
    if (existsSync(root)) {
      return { root, cloned: true, commands: detectRepoCommands(root), remoteUrl: adoptCheckout(root, trimmed) };
    }
    mkdirSync(reposDir(), { recursive: true, mode: 0o700 });
    try {
      execFileSync("git", ["clone", trimmed, root], { encoding: "utf8", timeout: CLONE_TIMEOUT_MS, stdio: "pipe" });
    } catch (e) {
      const err = e as Error & { stderr?: string };
      throw new WorkflowError("WORKSPACE_ERROR", `clone failed: ${(err.stderr || err.message).trim().slice(0, 400)}`);
    }
    return { root, cloned: true, commands: detectRepoCommands(root), remoteUrl: readRemoteUrl(root) ?? trimmed };
  }

  const root = resolve(trimmed.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(root)) throw new WorkflowError("WORKSPACE_ERROR", `"${trimmed}" does not exist`);
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  } catch {
    throw new WorkflowError("WORKSPACE_ERROR", `"${trimmed}" is not a git repository`);
  }
  return { root, cloned: false, commands: detectRepoCommands(root), remoteUrl: readRemoteUrl(root) };
}

/**
 * Take over a checkout that is already standing where this one would be cloned.
 *
 * Forgetting a repository now removes the checkout gate cloned, so a directory
 * still here is one something is holding open, or one an older gate left
 * behind — and in both cases cloning the same URL again would only reproduce
 * the commits already in it. Refusing instead made the id unusable forever:
 * the same repository, connected and forgotten, could never be connected back.
 *
 * It is taken over only when it *is* the repository being asked for, decided
 * by its origin and not by its directory name. A directory holding anything
 * else is still refused, because cloning into it would land this repository on
 * top of somebody else's work. The checkout is adopted at whatever commit it
 * stands on; the first pull moves it.
 */
function adoptCheckout(root: string, source: string): string | null {
  const url = readRemoteUrl(root);
  const here = url ? canonicalRepoId(url) : null;
  const wanted = canonicalRepoId(source);
  if (!here || !wanted || here !== wanted) {
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `${root} already holds ${here ?? "something that is not a checkout of it"}; pick another id or remove it first`,
    );
  }
  return url;
}

/**
 * Whether two paths name the same directory, symlinks resolved.
 *
 * `resolve` is not enough: git answers in real paths, so on a machine where
 * `/var` is a link to `/private/var` a checkout's own worktree did not match
 * its root, every checkout looked held open, and nothing was ever removed.
 * A path that does not exist cannot be resolved and is compared as written.
 */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * The worktrees a checkout is still holding open, its own excluded.
 *
 * A run's worktree is a real `git worktree` of the checkout, so the checkout's
 * `.git` is the only copy of that worktree's history: remove it and the run
 * cannot commit, publish or even say what it changed. This is what the
 * checkout is asked before anything deletes it.
 */
export function heldWorktrees(root: string): string[] {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return out
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter((path) => path && !samePath(path, root));
  } catch {
    // Not a git checkout, or git cannot read it. It holds no worktree either
    // way, and whether it may be removed is the caller's question, not this
    // one's.
    return [];
  }
}

export interface CheckoutRemoval {
  removed: boolean;
  root: string;
  /** Why it is still there, when it is. */
  kept?: string;
}

/**
 * Remove the checkout gate cloned for a repository.
 *
 * Only ever gate's own: a repository connected by path is somebody's working
 * copy, and "remove from the list" is not permission to delete it. A checkout
 * gate did clone is gate's to remove, and leaving it behind meant reconnecting
 * the same repository failed on a directory nothing claimed any more.
 *
 * A checkout that still has worktrees branched from it is kept and says so.
 * Those runs are what the `.git` is for, and `gate clean` is what ends them.
 */
export function removeRepoCheckout(repo: RepoRecord): CheckoutRemoval {
  const root = repo.root;
  if (!repo.cloned || !samePath(root, join(reposDir(), repo.id))) {
    return { removed: false, root, kept: "gate did not clone this checkout" };
  }
  if (!existsSync(root)) return { removed: true, root };

  const held = heldWorktrees(root);
  if (held.length) {
    return { removed: false, root, kept: `worktrees still branch from it: ${held.slice(0, 5).join(", ")}` };
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (e) {
    return { removed: false, root, kept: (e as Error).message };
  }
  return { removed: true, root };
}

/**
 * Reads the identity of every repository registered before there was one.
 *
 * Not a guess and not a migration that can be wrong: it asks each checkout
 * what its own origin is, exactly as connecting would today. A repo with no
 * remote, or one whose checkout has since been moved away, simply stays
 * unknown — which is the correct answer for it, and stays correct until
 * somebody points it at a remote.
 *
 * Runs once at startup, and only looks at repos that have no identity yet, so
 * a gate with a hundred repositories pays for it once.
 */
export function backfillRepoIdentities(): { named: number; unknown: number; disagreed: string[] } {
  let named = 0;
  let unknown = 0;
  const disagreed: string[] = [];
  for (const repo of listRepos()) {
    if (repo.repoId) continue;
    const url = existsSync(repo.root) ? readRemoteUrl(repo.root) : null;
    const result = setRepoRemote(repo.id, url);
    if (!result.ok) disagreed.push(`${repo.id}: ${result.was} vs ${result.now}`);
    else if (result.repo?.repoId) named++;
    else unknown++;
  }
  return { named, unknown, disagreed };
}

/**
 * Run one command, keeping the tail of what it said.
 *
 * `spawn` and a rolling buffer, not `execFile` with a `maxBuffer`: that option
 * does not truncate, it **kills the child** once the limit is passed. A
 * `pnpm install` prints megabytes of progress, so the install died of the log
 * rather than of anything wrong with it — and the log then held only progress
 * noise, saying nothing about why. Output can no longer end a command; only
 * the command's own exit code and the timeout can.
 */
function runOne(argv: string[], cwd: string): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolvePromise) => {
    const [file, ...args] = argv;
    const child = spawn(file, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

    let tail = "";
    const keep = (chunk: Buffer) => {
      tail += chunk.toString();
      if (tail.length > MAX_LOG_BYTES) tail = tail.slice(-MAX_LOG_BYTES);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);

    let done = false;
    const finish = (ok: boolean, note?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ ok, log: `$ ${argv.join(" ")}\n${tail.trim()}${note ? `\n-> ${note}` : ""}` });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, `timed out after ${Math.round(COMMAND_TIMEOUT_MS / 60_000)} minutes`);
    }, COMMAND_TIMEOUT_MS);

    child.on("error", (e) => finish(false, e.message));
    child.on("close", (code) => finish(code === 0, code === 0 ? undefined : `exited ${code ?? "on a signal"}`));
  });
}

/**
 * Run a repository's setup commands in its checkout, in order, stopping at the
 * first failure. Status and the whole log land on the record so the page can
 * say what happened without the person going to a terminal.
 */
export async function runRepoSetup(id: string): Promise<RepoRecord | null> {
  const repo = getRepo(id);
  if (!repo) return null;
  if (!repo.setup.length) {
    setRepoStatus(id, "ready", "No setup commands — nothing to run.");
    return getRepo(id);
  }

  setRepoStatus(id, "installing");
  const parts: string[] = [];
  for (const argv of repo.setup) {
    const { ok, log } = await runOne(argv, repo.root);
    parts.push(log);
    if (!ok) {
      setRepoStatus(id, "failed", parts.join("\n\n").slice(-MAX_LOG_BYTES));
      return getRepo(id);
    }
  }
  setRepoStatus(id, "ready", parts.join("\n\n").slice(-MAX_LOG_BYTES));
  return getRepo(id);
}

/**
 * Fetch and fast-forward a connected repository.
 *
 * Fast-forward only, deliberately: this checkout is shared by every run and is
 * not a place to resolve a merge. If it will not fast-forward, that is a person's
 * decision and the log says so rather than leaving a half-merged tree behind.
 *
 * The setup commands run again afterwards, because a pull that moved the
 * lockfile and did not reinstall is how a worktree ends up borrowing
 * dependencies that no longer match the code.
 */
export async function pullRepo(id: string): Promise<RepoRecord | null> {
  const repo = getRepo(id);
  if (!repo) return null;

  setRepoStatus(id, "installing");
  const parts: string[] = [];
  for (const argv of [
    ["git", "fetch", "--prune", "--quiet"],
    ["git", "pull", "--ff-only"],
  ]) {
    const { ok, log } = await runOne(argv, repo.root);
    parts.push(log);
    if (!ok) {
      setRepoStatus(id, "failed", parts.join("\n\n").slice(-MAX_LOG_BYTES));
      return getRepo(id);
    }
  }

  for (const argv of repo.setup) {
    const { ok, log } = await runOne(argv, repo.root);
    parts.push(log);
    if (!ok) {
      setRepoStatus(id, "failed", parts.join("\n\n").slice(-MAX_LOG_BYTES));
      return getRepo(id);
    }
  }
  setRepoStatus(id, "ready", parts.join("\n\n").slice(-MAX_LOG_BYTES));
  return getRepo(id);
}

/**
 * Get a fresh worktree ready: borrow the checkout's installed dependencies,
 * then run whatever the repo said each worktree needs.
 *
 * Symlinked rather than copied — `node_modules` is gigabytes and identical to
 * the one next door. Failures here are fatal on purpose: a run whose worktree
 * is half-prepared fails later, further from the cause, and usually after
 * spending money on a plan.
 */
export async function prepareWorktree(repo: RepoRecord, worktreeRoot: string): Promise<void> {
  for (const dir of linkedDirectories(repo.root)) {
    const target = join(worktreeRoot, dir);
    if (existsSync(target)) continue;
    try {
      symlinkSync(join(repo.root, dir), target, "dir");
    } catch (e) {
      throw new WorkflowError("WORKSPACE_ERROR", `could not link ${dir} into the worktree: ${(e as Error).message}`);
    }
  }

  for (const argv of repo.prepare) {
    const { ok, log } = await runOne(argv, worktreeRoot);
    if (!ok) {
      throw new WorkflowError(
        "WORKSPACE_ERROR",
        `preparing the worktree failed: ${log.split("\n").slice(0, 6).join(" ").slice(0, 400)}`,
      );
    }
  }
}

/** Absolute paths only, so a repo id can never be mistaken for one. */
export function isPathLike(source: string): boolean {
  return source.startsWith("/") || source.startsWith("~") || source.startsWith(".") || isAbsolute(source);
}
