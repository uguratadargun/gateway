import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * What the gate's own checkout of a repository needs once it is cloned:
 * **setup** runs in it, to fetch dependencies. Detected as a starting point,
 * not a verdict: the guess is prefilled into the form and the person adding
 * the repo edits it.
 */

export interface RepoCommands {
  setup: string[][];
  /** What the detection keyed off, so the form can say why it guessed this. */
  reason: string;
}

export function detectRepoCommands(root: string): RepoCommands {
  const has = (f: string) => existsSync(join(root, f));

  if (has("package.json")) {
    // The lockfile is the honest answer to "which package manager", ahead of
    // whatever `packageManager` claims — it is what CI would key off too.
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : "npm";
    const install =
      pm === "npm" ? (has("package-lock.json") ? ["npm", "ci"] : ["npm", "install"]) : [pm, "install"];
    return {
      setup: [install],
      reason: has("pnpm-lock.yaml")
        ? "pnpm-lock.yaml"
        : has("yarn.lock")
          ? "yarn.lock"
          : has("bun.lockb")
            ? "bun.lockb"
            : has("package-lock.json")
              ? "package-lock.json"
              : "package.json",
    };
  }

  if (has("uv.lock")) return { setup: [["uv", "sync"]], reason: "uv.lock" };
  if (has("poetry.lock")) return { setup: [["poetry", "install"]], reason: "poetry.lock" };
  if (has("requirements.txt")) {
    return { setup: [["python3", "-m", "pip", "install", "-r", "requirements.txt"]], reason: "requirements.txt" };
  }
  if (has("Cargo.toml")) return { setup: [["cargo", "fetch"]], reason: "Cargo.toml" };
  if (has("go.mod")) return { setup: [["go", "mod", "download"]], reason: "go.mod" };
  if (has("Gemfile")) return { setup: [["bundle", "install"]], reason: "Gemfile" };

  return { setup: [], reason: "nothing recognised — say what this repo needs yourself" };
}

/**
 * Dependencies a worktree cannot bring with it.
 *
 * Reinstalling per run would cost minutes and gigabytes for a result identical
 * to the checkout's, so the worktree borrows it instead. A symlink, because
 * these directories are large and disposable.
 */
export const LINKED_DIRECTORIES = ["node_modules", "vendor", ".venv"] as const;

export function linkedDirectories(root: string): string[] {
  return LINKED_DIRECTORIES.filter((d) => existsSync(join(root, d)));
}
