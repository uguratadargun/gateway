/**
 * In-process activity feed for the live dashboard tail. Pub/sub with a small
 * replay buffer so a newly opened stream sees recent events immediately.
 */

export interface ActivityEvent {
  ts: number;
  kind: "request" | "queue" | "throttle" | "fallback";
  endpoint?: string;
  requested?: string;
  model?: string;
  tier?: string;
  status?: number;
  stream?: boolean;
  fromCache?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  durationMs?: number;
  note?: string;
}

type Listener = (e: ActivityEvent) => void;

const g = globalThis as unknown as { __gateActivity?: { listeners: Set<Listener>; recent: ActivityEvent[] } };
const state = (g.__gateActivity ??= { listeners: new Set(), recent: [] });
const REPLAY = 30;

export function publishActivity(e: ActivityEvent): void {
  state.recent.push(e);
  if (state.recent.length > REPLAY) state.recent.shift();
  for (const l of state.listeners) {
    try {
      l(e);
    } catch {
      // a broken listener must not affect others
    }
  }
}

export function subscribeActivity(l: Listener): () => void {
  state.listeners.add(l);
  return () => state.listeners.delete(l);
}

export function recentActivity(): ActivityEvent[] {
  return [...state.recent];
}
