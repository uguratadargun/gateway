import { loadSettings } from "./settings";

/**
 * Concurrency limiter: at most N upstream requests in flight; the rest wait in
 * FIFO order up to a timeout. Protects the account from burst traffic (e.g.
 * parallel subagents) that trips rate limits. Process-wide, HMR-safe.
 */

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Semaphore {
  private inFlight = 0;
  private queue: Waiter[] = [];
  private coalescedTotal = 0;
  private queuedTotal = 0;
  private timeoutsTotal = 0;

  constructor(private readonly maxFn: () => number) {}

  private makeRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlight--;
      this.pump();
    };
  }

  private pump(): void {
    while (this.inFlight < this.maxFn() && this.queue.length > 0) {
      const w = this.queue.shift()!;
      clearTimeout(w.timer);
      this.inFlight++;
      w.resolve(this.makeRelease());
    }
  }

  acquire(timeoutMs: number): Promise<() => void> {
    if (this.inFlight < this.maxFn()) {
      this.inFlight++;
      return Promise.resolve(this.makeRelease());
    }
    this.queuedTotal++;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          this.timeoutsTotal++;
          reject(new Error("queue_timeout"));
        }, timeoutMs),
      };
      this.queue.push(waiter);
    });
  }

  noteCoalesced(): void {
    this.coalescedTotal++;
  }

  stats() {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      max: this.maxFn(),
      queuedTotal: this.queuedTotal,
      timeoutsTotal: this.timeoutsTotal,
      coalescedTotal: this.coalescedTotal,
    };
  }
}

const g = globalThis as unknown as { __gateLimiter?: Semaphore };

export function getLimiter(): Semaphore {
  if (!g.__gateLimiter) g.__gateLimiter = new Semaphore(() => loadSettings().concurrency.maxInFlight);
  return g.__gateLimiter;
}
