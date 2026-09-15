import type { PublicationTarget, PublishOutcome } from "@/repos/publish";
import { releaseRunWorkspace, type RunWorkspace } from "@/runtime/workspace";

import type { GateClient } from "./api";

/**
 * Ending a run's workspace on this machine, and telling the gate where the
 * branch ended up.
 *
 * The push happens here, on the machine that has the worktree — the server
 * has no checkout of anyone's repository and could not do it even if it
 * wanted to. What it gets is the result: the ref and the commit the remote
 * itself reported, or the reason there is none.
 *
 * Both `gate run` and a session-driven run end this way, which is why it is
 * one function: the two paths had already drifted apart once over what a
 * released worktree prints.
 */
export async function releaseAndPublish(
  client: GateClient,
  workspace: RunWorkspace,
  executionId: string,
  /**
   * Where the run's repository publishes, as the server answered. Null and
   * undefined mean the same thing — no target, nothing pushed, nothing said
   * about it — so a repository that does not publish and a gate too old to
   * have an opinion both end a run in silence rather than with a warning.
   */
  publish: PublicationTarget | null | undefined,
  say?: (line: string) => void,
): Promise<void> {
  // A box, not a plain `let`: assigned only inside the callback, which the
  // compiler cannot see happening before the call returns.
  const captured: { outcome: PublishOutcome | null } = { outcome: null };
  const released = releaseRunWorkspace(workspace, executionId, {
    publish: publish ?? undefined,
    onPublished: (o) => {
      captured.outcome = o;
    },
  });
  if (released) say?.(released);

  const outcome = captured.outcome;
  if (!outcome) return;
  await client
    .report(executionId, {
      events: [],
      steps: [],
      published: outcome.ok ? outcome.published : { error: outcome.note },
    })
    // The branch is where it is whether or not the gate hears about it: a
    // failed report here must not be the last word of an otherwise fine run.
    .catch((e) => say?.(`the branch was dealt with, but the gate could not be told: ${(e as Error).message}`));
}
