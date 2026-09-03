import { getLimiter } from "./limiter";

/**
 * In-flight request coalescing: if an identical (deterministic, non-stream)
 * request is already being served, later callers share its result instead of
 * spending quota again. Typical trigger: client retry storms.
 */

const g = globalThis as unknown as { __gateInflight?: Map<string, Promise<unknown>> };
const inflight = (g.__gateInflight ??= new Map());

export async function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) {
    getLimiter().noteCoalesced();
    return existing;
  }
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

export function inflightCount(): number {
  return inflight.size;
}
