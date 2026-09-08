/**
 * What a server and a client have to agree on.
 *
 * They no longer ship together: the server is deployed once and the CLI lives
 * on every developer's machine, updated whenever that person gets round to
 * `/gate:update`. Skew is therefore normal, and the only question is whether
 * it is *visible* — an old client meeting a route that did not exist when it
 * was built otherwise gets a 404 and reports something that reads like a bug in
 * the workflow.
 *
 * Both numbers are baked into each build of this file, so a client carries the
 * pair it was built with and the server carries its own; comparing them is the
 * whole mechanism.
 *
 * - Bump `GATE_VERSION` whenever the client or the server changes.
 * - Bump `MIN_CLIENT_VERSION` only when a change actually breaks older clients
 *   — a removed field, a required parameter, a changed meaning. Raising it
 *   stops those clients dead, which is the point, so it is not a routine bump.
 *
 * Nothing here may import anything: it is read by the edge middleware and
 * bundled into the CLI.
 */

export const GATE_VERSION = "0.24.2";

/** The oldest CLI this server will serve. Older ones are refused, with the fix. */
export const MIN_CLIENT_VERSION = "0.13.0";

/** Header names the two ends use to tell each other what they are. */
export const VERSION_HEADERS = {
  /** Client → server: the CLI's own version. */
  client: "x-gate-cli",
  /** Server → client: what is running there. */
  server: "x-gate-server",
  /** Server → client: the oldest client it will serve. */
  minClient: "x-gate-min-cli",
} as const;

/**
 * Compares two `major.minor.patch` strings. Negative when `a` is older.
 *
 * Anything unparseable sorts as 0.0.0 rather than throwing: a version this
 * cannot read is a reason to warn, never a reason to fail a run.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .split(".")
      .map((n) => Number.parseInt(n, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isOlderThan(version: string, than: string): boolean {
  return compareVersions(version, than) < 0;
}
