import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { WorkflowError } from "@/runtime/errors";
import type { WorkflowDefinition } from "@/workflows/types";

/**
 * A path, as opposed to the id of a repository connected to the server. An id
 * means nothing here until this machine says which of its own clones it is.
 */
function isPathLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.startsWith(".") || value.includes("/");
}

/** The repository a run works in, resolved on this machine. */
export function resolveRepo(
  workflow: WorkflowDefinition,
  input: Record<string, unknown>,
  cwd: string,
  /** This machine's own answer to a connected repo's id — `gate repo <id> <path>`. */
  repos: Record<string, string> = {},
): string {
  const given = typeof input.repo === "string" ? input.repo.trim() : "";
  const pinned = workflow.workspace?.repo?.trim() ?? "";
  // An explicit input wins over a pin.
  const named = given || pinned;

  if (named && !isPathLike(named)) {
    // A workflow pinned to a repository the server has connected. Here it can
    // only mean whichever clone of that project this person keeps, and only
    // they know.
    const mapped = repos[named];
    if (mapped) return resolve(mapped.replace(/^~(?=\/|$)/, homedir()));
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `this workflow works in the connected repository "${named}", which this machine has no checkout for — ` +
        `run \`gate repo ${named} /path/to/your/clone\` once, or pass --input repo=/path/to/your/clone`,
    );
  }
  if (named) return resolve(named.replace(/^~(?=\/|$)/, homedir()));

  // Otherwise: the repository the person is standing in.
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `this workflow works in a repository, and ${cwd} is not one — run it from a checkout, or pass --input repo=/path/to/repo`,
    );
  }
}
