import { randomBytes } from "node:crypto";

import type { Principal } from "./apikeys";

/**
 * A token that authenticates as one run, alive only while that run is.
 *
 * gate's own children have to get through gate's own front door: a node handed
 * to a headless Claude Code calls the gateway like anybody else, and on a gate
 * that has issued any key a request without one is refused whatever its source
 * address. So a run carries a credential of its own, minted when it starts and
 * dropped when it ends — resolving to the run's own person and team, so what
 * the child spends is filed against the run rather than against nobody.
 *
 * It is never written down: no `apikeys` row, no table, no file. The registry
 * lives in this process, which means a restart invalidates every token there
 * is, and that is the point — a token that outlived its run, or that survived
 * the process that minted it, is the thing this shape makes impossible. A run
 * whose gate restarted under it has lost more than its token.
 *
 * Nothing outside this module knows how a run token is made, stored or
 * matched. It imports only the `Principal` type from `./apikeys`, and nothing
 * from `./gate-auth` — which imports it. That direction is deliberate: the
 * reverse would be a cycle.
 */

interface Registry {
  /** token -> who it answers as. */
  byToken: Map<string, Principal>;
  /** executionId -> its live token, so a second mint replaces rather than leaks. */
  byExecution: Map<string, string>;
}

/**
 * Hung off globalThis for the same reason `__gateRunsInFlight` is: route
 * handlers and the runner do not share a module registry in dev, and a
 * per-module Map would leave the gateway looking at an empty one while the
 * run that minted the token is going.
 */
const g = globalThis as unknown as { __gateRunTokens?: Registry };
const registry = (g.__gateRunTokens ??= {
  byToken: new Map<string, Principal>(),
  byExecution: new Map<string, string>(),
});

/**
 * Visibly not an issued key, which is `gate_` followed by 48 hex characters.
 * 24 random bytes: a token that is guessed is a token that spends somebody
 * else's quota as them.
 */
function mint(): string {
  return `gate_run_${randomBytes(24).toString("hex")}`;
}

function drop(executionId: string, token: string): void {
  registry.byToken.delete(token);
  // Only if this run still owns it: a later mint for the same id has already
  // taken the slot, and dropping it here would revoke a live token.
  if (registry.byExecution.get(executionId) === token) registry.byExecution.delete(executionId);
}

/**
 * Runs `body` with a bearer token that authenticates as this run, and drops the
 * token however the run ends — returned, thrown or rejected.
 */
export async function withRunToken<T>(
  executionId: string,
  principal: Principal,
  body: (token: string) => Promise<T>,
): Promise<T> {
  // Before the first await: the token has to exist the moment this is called,
  // because the run inside it may reach the gateway on its first tick.
  const token = mint();
  const previous = registry.byExecution.get(executionId);
  if (previous) registry.byToken.delete(previous);
  // So no caller has to remember to set it: every request made on a run's
  // token carries the run, whatever the principal it was minted with said.
  registry.byToken.set(token, { ...principal, executionId });
  registry.byExecution.set(executionId, token);
  try {
    return await body(token);
  } finally {
    drop(executionId, token);
  }
}

/** The principal behind a run token, or null when this process minted no such token. */
export function resolveRunToken(token: string): Principal | null {
  if (!token) return null;
  return registry.byToken.get(token) ?? null;
}
