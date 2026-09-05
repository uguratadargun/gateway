import type { WorkflowEvent } from "./types";

/**
 * Per-execution pub/sub for the live graph, mirroring lib/activity.ts. Gate is
 * a single process, so an in-memory bus is the whole requirement — no broker.
 * Each execution keeps a replay buffer so a page opened mid-run (or just after
 * one finishes) still renders the path taken.
 */

type Listener = (e: WorkflowEvent) => void;

interface Topic {
  listeners: Set<Listener>;
  events: WorkflowEvent[];
  done: boolean;
  lastAt: number;
}

const g = globalThis as unknown as { __gateWorkflowBus?: Map<string, Topic> };
const topics = (g.__gateWorkflowBus ??= new Map<string, Topic>());

const MAX_BUFFERED = 500;
/** How long a finished run stays replayable in memory before eviction. */
const RETAIN_MS = 10 * 60_000;
const MAX_TOPICS = 50;

function topic(executionId: string): Topic {
  let t = topics.get(executionId);
  if (!t) {
    t = { listeners: new Set(), events: [], done: false, lastAt: Date.now() };
    topics.set(executionId, t);
    evict();
  }
  return t;
}

function evict(): void {
  const now = Date.now();
  for (const [id, t] of topics) {
    if (t.done && !t.listeners.size && now - t.lastAt > RETAIN_MS) topics.delete(id);
  }
  if (topics.size <= MAX_TOPICS) return;
  // Oldest first, skipping the ones someone is still watching — a single open
  // SSE connection must not stop the sweep for everything behind it.
  const evictable = [...topics.entries()].filter(([, t]) => !t.listeners.size).sort((a, b) => a[1].lastAt - b[1].lastAt);
  for (const [id] of evictable) {
    if (topics.size <= MAX_TOPICS) break;
    topics.delete(id);
  }
}

export function publishWorkflowEvent(e: WorkflowEvent): void {
  const t = topic(e.executionId);
  t.events.push(e);
  t.lastAt = e.at;
  if (t.events.length > MAX_BUFFERED) t.events.shift();
  if (e.type === "workflow.completed" || e.type === "workflow.failed") t.done = true;
  for (const l of t.listeners) {
    try {
      l(e);
    } catch {
      // a broken listener must not affect others
    }
  }
}

/** Subscribe to an execution; the listener first receives buffered events. */
export function subscribeWorkflow(executionId: string, listener: Listener): () => void {
  const t = topic(executionId);
  for (const e of [...t.events]) {
    try {
      listener(e);
    } catch {
      // ignore
    }
  }
  t.listeners.add(listener);
  return () => {
    t.listeners.delete(listener);
    t.lastAt = Date.now();
  };
}

export function workflowEvents(executionId: string): WorkflowEvent[] {
  return [...(topics.get(executionId)?.events ?? [])];
}

export function isExecutionFinished(executionId: string): boolean {
  return topics.get(executionId)?.done ?? false;
}
