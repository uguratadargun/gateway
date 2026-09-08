import type { WorkflowEvent } from "@/events/types";
import type { StepRecord } from "@/runtime/state";

import type { GateClient } from "./api";

/**
 * What a local run tells the server, and the one thing the server tells it back.
 *
 * Batched rather than per-event: a run makes hundreds of tool calls and a
 * request each would be slower than the work. The interval is short enough that
 * the dashboard still animates roughly in step with the machine doing the work.
 *
 * Reporting never fails a run. A network blip while someone's agent is halfway
 * through a repository is not a reason to throw the work away, so failures keep
 * the payload buffered and try again next tick; the buffer is capped so a long
 * outage cannot grow without bound.
 *
 * The reply carries `cancelRequested`, which is how Stop in the dashboard
 * reaches a process the server cannot see: the run aborts itself.
 */

const FLUSH_INTERVAL_MS = 1000;
/**
 * How long the reporter may stay silent when there is nothing to say.
 *
 * It is not only a keep-alive: this is also the only moment a run learns that
 * someone pressed Stop, because the answer rides back on the report. A node
 * that runs for twenty minutes without emitting anything would otherwise take
 * as long to notice, so the interval is set by how quickly Stop should feel
 * like it worked, not by what the abandoned-run sweep needs.
 */
const HEARTBEAT_MS = 5_000;
const MAX_BUFFERED_EVENTS = 2000;
const MAX_BUFFERED_STEPS = 200;

export class RunReporter {
  private events: WorkflowEvent[] = [];
  private steps: StepRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private lastSentAt = Date.now();
  private stopped = false;
  /** The flag stays set on the server; the run only needs telling once. */
  private cancelSeen = false;

  constructor(
    private readonly client: GateClient,
    private readonly executionId: string,
    /** Called once, when the server reports that someone pressed Stop. */
    private readonly onCancel: () => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    // Never hold the process open on the reporter's account: a finished run
    // must exit even if a flush is still pending.
    this.timer.unref?.();
  }

  event(event: WorkflowEvent): void {
    if (this.events.length >= MAX_BUFFERED_EVENTS) this.events.shift();
    this.events.push(event);
  }

  step(step: StepRecord): void {
    if (this.steps.length >= MAX_BUFFERED_STEPS) this.steps.shift();
    this.steps.push(step);
  }

  /** Sends what is buffered. Safe to call concurrently; overlapping calls no-op. */
  async flush(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    const idle = !this.events.length && !this.steps.length;
    if (idle && Date.now() - this.lastSentAt < HEARTBEAT_MS) return;

    const events = this.events;
    const steps = this.steps;
    this.events = [];
    this.steps = [];
    this.inFlight = true;
    try {
      const res = await this.client.report(this.executionId, { events, steps });
      this.lastSentAt = Date.now();
      if (res.cancelRequested && !this.cancelSeen) {
        this.cancelSeen = true;
        this.onCancel();
      }
    } catch {
      // Put it back at the front: order is what makes a replay readable.
      this.events = [...events, ...this.events].slice(-MAX_BUFFERED_EVENTS);
      this.steps = [...steps, ...this.steps].slice(-MAX_BUFFERED_STEPS);
    } finally {
      this.inFlight = false;
    }
  }

  /** Final flush, then stop reporting. Called once the engine has settled. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // The last node's step is the one most worth having, and a flush already in
    // flight would make an immediate retry a no-op — so wait for it, then send
    // what is left. A couple of attempts, then let go: the run is over and the
    // finish report carries its outcome regardless.
    for (let attempt = 0; attempt < 4 && (this.inFlight || this.events.length || this.steps.length); attempt++) {
      if (this.inFlight) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      this.lastSentAt = 0;
      await this.flush();
    }
    this.stopped = true;
  }
}
