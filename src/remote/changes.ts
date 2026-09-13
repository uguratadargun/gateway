import { execFile, type ExecFileException } from "node:child_process";

import type { ChangedFile } from "./types";

/**
 * A remote run's changed files, read from its worktree on this server.
 *
 * The cockpit shows a desktop run's changes by running `git` in the session's
 * directory (src/main/changedFiles.ts there). A remote run's directory is
 * here, so the same reading is done here and handed back in the same shape:
 * `status` for which paths changed, `diff --numstat` against HEAD for the
 * counts, and one file's diff on demand.
 */

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err: ExecFileException | null, stdout, stderr) => {
      // `git diff` exits 1 to mean "there are differences"; only other codes are failures.
      if (err && err.code !== 1) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

interface Numstat {
  additions: number;
  deletions: number;
  binary: boolean;
}

const RENAME_KEY_SEP = "\0";

function parseNumstat(stdout: string): { plain: Map<string, Numstat>; renamed: Map<string, Numstat> } {
  const plain = new Map<string, Numstat>();
  const renamed = new Map<string, Numstat>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, rest] = line.split("\t");
    if (rest === undefined) continue;
    const binary = a === "-" || d === "-";
    const stat: Numstat = { additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary };
    if (rest.includes(" => ")) {
      const braced = rest.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
      const [oldPath, newPath] = braced ? [braced[1] + braced[2] + braced[4], braced[1] + braced[3] + braced[4]] : rest.split(" => ");
      renamed.set(oldPath + RENAME_KEY_SEP + newPath, stat);
    } else {
      plain.set(rest, stat);
    }
  }
  return { plain, renamed };
}

function parseStatus(stdout: string): Array<{ code: string; path: string; oldPath?: string }> {
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  const out: Array<{ code: string; path: string; oldPath?: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (code.includes("R") || code.includes("C")) out.push({ code, path, oldPath: tokens[++i] });
    else out.push({ code, path });
  }
  return out;
}

export async function changedFilesIn(cwd: string): Promise<ChangedFile[]> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error("not a git repository");
  }
  const [statusRes, numstatRes] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(cwd, ["diff", "--numstat", "-M", "HEAD"]).catch(() => ({ stdout: "", stderr: "" })),
  ]);
  const { plain, renamed } = parseNumstat(numstatRes.stdout);
  const files: ChangedFile[] = [];
  for (const e of parseStatus(statusRes.stdout)) {
    if (e.code === "!!") continue;
    const untracked = e.code[0] === "?" || e.code[1] === "?";
    const status: ChangedFile["status"] = e.oldPath
      ? "renamed"
      : untracked
        ? "added"
        : e.code.includes("D")
          ? "deleted"
          : e.code.includes("A")
            ? "added"
            : "modified";
    let stat: Numstat = { additions: 0, deletions: 0, binary: false };
    if (untracked) {
      try {
        const { stdout } = await git(cwd, ["diff", "--no-index", "--numstat", "--", "/dev/null", e.path]);
        const [a, d] = stdout.trim().split("\t");
        if (a !== undefined) {
          const binary = a === "-" || d === "-";
          stat = { additions: binary ? 0 : Number(a), deletions: binary ? 0 : Number(d), binary };
        }
      } catch {
        // a file git will not diff; 0/0
      }
    } else if (status === "renamed" && e.oldPath) {
      stat = renamed.get(e.oldPath + RENAME_KEY_SEP + e.path) ?? stat;
    } else {
      stat = plain.get(e.path) ?? stat;
    }
    files.push({ path: e.path, ...(e.oldPath ? { oldPath: e.oldPath } : {}), status, ...stat, untracked });
  }
  return files;
}

/** Refuses a path that climbs out of the worktree: it came from the network. */
function inside(path: string): boolean {
  return !!path && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

export async function fileDiffIn(cwd: string, file: ChangedFile): Promise<string> {
  if (!inside(file.path) || (file.oldPath !== undefined && !inside(file.oldPath))) throw new Error("a path outside the worktree");
  if (file.untracked) return (await git(cwd, ["diff", "--no-index", "--", "/dev/null", file.path])).stdout;
  const args = file.oldPath ? ["diff", "-M", "HEAD", "--", file.oldPath, file.path] : ["diff", "HEAD", "--", file.path];
  return (await git(cwd, args)).stdout;
}
