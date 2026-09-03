import { describe, expect, it } from "vitest";

import { Semaphore } from "@/lib/limiter";

describe("Semaphore", () => {
  it("admits up to max, queues the rest, and admits on release", async () => {
    const s = new Semaphore(() => 2);
    const r1 = await s.acquire(1000);
    const r2 = await s.acquire(1000);
    expect(s.stats().inFlight).toBe(2);
    let admitted = false;
    const p3 = s.acquire(1000).then((rel) => {
      admitted = true;
      return rel;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(admitted).toBe(false);
    expect(s.stats().queued).toBe(1);
    r1();
    const r3 = await p3;
    expect(admitted).toBe(true);
    expect(s.stats().inFlight).toBe(2);
    r2();
    r3();
    expect(s.stats().inFlight).toBe(0);
  });

  it("rejects a waiter that times out", async () => {
    const s = new Semaphore(() => 1);
    const r1 = await s.acquire(1000);
    await expect(s.acquire(20)).rejects.toThrow("queue_timeout");
    expect(s.stats().timeoutsTotal).toBe(1);
    r1();
  });

  it("release is idempotent", async () => {
    const s = new Semaphore(() => 1);
    const rel = await s.acquire(100);
    rel();
    rel();
    expect(s.stats().inFlight).toBe(0);
  });
});
