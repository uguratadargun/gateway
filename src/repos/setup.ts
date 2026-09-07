import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { WorkflowError } from "@/runtime/errors";

import { detectRepoCommands, linkedDirectories, type RepoCommands } from "./detect";
import { getRepo, setRepoStatus, type RepoRecord } from "./store";

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
      throw new WorkflowError("WORKSPACE_ERROR", `${root} already exists; pick another id or remove it first`);
    }
    mkdirSync(reposDir(), { recursive: true, mode: 0o700 });
    try {
      execFileSync("git", ["clone", trimmed, root], { encoding: "utf8", timeout: CLONE_TIMEOUT_MS, stdio: "pipe" });
    } catch (e) {
      const err = e as Error & { stderr?: string };
      throw new WorkflowError("WORKSPACE_ERROR", `clone failed: ${(err.stderr || err.message).trim().slice(0, 400)}`);
    }
    return { root, cloned: true, commands: detectRepoCommands(root) };
  }

  const root = resolve(trimmed.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(root)) throw new WorkflowError("WORKSPACE_ERROR", `"${trimmed}" does not exist`);
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8", stdio: "pipe" });
  } catch {
    throw new WorkflowError("WORKSPACE_ERROR", `"${trimmed}" is not a git repository`);
  }
  return { root, cloned: false, commands: detectRepoCommands(root) };
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
