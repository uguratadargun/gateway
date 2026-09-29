import { execFileSync } from "node:child_process";

import type { WorkflowDefinition } from "@/workflows/types";

/**
 * What a run will need at its end that this machine does not have, said at
 * its start.
 *
 * Opening a pull request on GitHub takes an API token, and the one place a run
 * finds out it has none is the node that opens it — after every other node has
 * run. The run's own machine is the only one that could have the token, so it
 * is asked here, while the person is still at the start and one `gh auth
 * login` fixes it. It is a warning and not a refusal: a run that stops at the
 * commit never reaches the node, and whether it gets there is the graph's
 * business, not this check's.
 *
 * GitLab needs nothing here: without a signed-in glab the node falls back to
 * push options, which ride the same SSH key the clone already uses.
 */
export function shippingWarnings(
  workflow: WorkflowDefinition,
  remoteUrl: string | null | undefined,
  ghSignedIn: () => boolean = ghIsSignedIn,
): string[] {
  if (!remoteUrl || !/github\.com/i.test(remoteUrl)) return [];
  const opensPullRequest = workflow.nodes.some(
    (n) => n.type === "command" && !n.disabled && /\bgh\s+pr\s+create\b/.test(n.command.join(" ")),
  );
  if (!opensPullRequest || ghSignedIn()) return [];
  return [
    "⚠ this workflow opens a pull request with gh at its end, and gh is not signed in on this machine: " +
      "run `gh auth login` before the run gets there, or it ends with the branch committed and no pull request",
  ];
}

function ghIsSignedIn(): boolean {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    // Not installed, not signed in, or a token the host rejects: all three
    // fail the node the same way.
    return false;
  }
}
