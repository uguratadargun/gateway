import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a repository needs before a run can work in it.
 *
 * Two different questions, and conflating them is what made every pipeline
 * carry its own copy of the answer:
 *
 * - **setup** runs once, in the repository itself: fetch dependencies, build
 *   whatever the tests import. Expensive, and shared by every run.
 * - **prepare** runs in each run's fresh worktree. A worktree carries what git
 *   tracks and nothing else, so the generated files the setup produced are not
 *   in it — measured on one Electron repo as 924 files in the checkout against
 *   2 in the worktree, which failed 19 test files identically on every pass
 *   until the pipeline generated them itself.
 *
 * Detected as a starting point, not a verdict: the guesses are prefilled into
 * the form and the person adding the repo edits them.
 */

export interface RepoCommands {
  setup: string[][];
  prepare: string[][];
  /** What the detection keyed off, so the form can say why it guessed this. */
  reason: string;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Scripts a JS project defines that are worth running before the tests. */
function jsPrepare(scripts: Record<string, unknown>, pm: string): string[][] {
  const out: string[][] = [];
  // Ordered the way a build does it: generated sources before transpilation.
  for (const name of ["build-protobuf", "generate", "codegen", "prisma:generate"]) {
    if (typeof scripts[name] === "string") out.push([pm, "run", name]);
  }
  for (const name of ["transpileNew", "transpile", "build:dev"]) {
    if (typeof scripts[name] === "string") {
      out.push([pm, "run", name]);
      break;
    }
  }
  return out;
}

export function detectRepoCommands(root: string): RepoCommands {
  const has = (f: string) => existsSync(join(root, f));

  if (has("package.json")) {
    const pkg = readJson(join(root, "package.json")) ?? {};
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    // The lockfile is the honest answer to "which package manager", ahead of
    // whatever `packageManager` claims — it is what CI would key off too.
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : "npm";
    const install =
      pm === "npm" ? (has("package-lock.json") ? ["npm", "ci"] : ["npm", "install"]) : [pm, "install"];
    return {
      setup: [install],
      prepare: jsPrepare(scripts, pm),
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

  if (has("uv.lock")) return { setup: [["uv", "sync"]], prepare: [], reason: "uv.lock" };
  if (has("poetry.lock")) return { setup: [["poetry", "install"]], prepare: [], reason: "poetry.lock" };
  if (has("requirements.txt")) {
    return { setup: [["python3", "-m", "pip", "install", "-r", "requirements.txt"]], prepare: [], reason: "requirements.txt" };
  }
  if (has("Cargo.toml")) return { setup: [["cargo", "fetch"]], prepare: [], reason: "Cargo.toml" };
  if (has("go.mod")) return { setup: [["go", "mod", "download"]], prepare: [], reason: "go.mod" };
  if (has("Gemfile")) return { setup: [["bundle", "install"]], prepare: [], reason: "Gemfile" };

  return { setup: [], prepare: [], reason: "nothing recognised — say what this repo needs yourself" };
}

/**
 * Dependencies a worktree cannot bring with it.
 *
 * Reinstalling per run would cost minutes and gigabytes for a result identical
 * to the checkout's, so the worktree borrows it instead. A symlink, because
 * these directories are large and disposable.
 */
export function linkedDirectories(root: string): string[] {
  return ["node_modules", "vendor", ".venv"].filter((d) => existsSync(join(root, d)));
}
