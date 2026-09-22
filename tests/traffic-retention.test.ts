import { describe, expect, it } from "vitest";

import { loadSettings, saveSettings } from "@/lib/settings";
import { settingsPatchSchema } from "@/lib/schemas";
import {
  clearTraffic,
  parseTrafficCursor,
  readTraffic,
  recordTraffic,
  trafficCursor,
} from "@/lib/traffic";

const DAY = 86_400_000;

const row = (ts: number, over: Partial<Parameters<typeof recordTraffic>[0]> = {}) => ({
  ts,
  endpoint: "messages",
  requested: "a",
  routed: "m",
  tier: "haiku",
  status: 200,
  stream: false,
  fromCache: false,
  requestPreview: "q",
  responsePreview: "r",
  ...over,
});

/**
 * The traffic log's retention window: a person's setting, not a compiled-in
 * row cap. Task 1 covers the setting itself; Task 2 extends this file with
 * the pruning and cursor-read behaviour that reads it.
 */

describe("the traffic log's retention window", () => {
  it("defaults to 7 days", () => {
    expect(loadSettings().traffic.retentionDays).toBe(7);
  });

  it("saves and persists a chosen window", () => {
    const saved = saveSettings({ traffic: { retentionDays: 30 } });
    expect(saved.traffic.retentionDays).toBe(30);
    expect(loadSettings().traffic.retentionDays).toBe(30);
  });

  it("clamps a non-positive window to the floor of 1 day", () => {
    const saved = saveSettings({ traffic: { retentionDays: 0 } });
    expect(saved.traffic.retentionDays).toBe(1);
  });

  it("leaves the stored value alone when the patch is not a finite number", () => {
    saveSettings({ traffic: { retentionDays: 14 } });
    // @ts-expect-error - exercising a hand-edited / malformed value
    const saved = saveSettings({ traffic: { retentionDays: "7" } });
    expect(saved.traffic.retentionDays).toBe(14);
  });

  it("refuses 0 at the schema and accepts the floor", () => {
    expect(settingsPatchSchema.safeParse({ traffic: { retentionDays: 0 } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ traffic: { retentionDays: 1 } }).success).toBe(true);
  });
});

describe("the traffic log's row bound is gone", () => {
  it("keeps every row written inside the window", () => {
    saveSettings({ traffic: { retentionDays: 7 } });
    clearTraffic();
    const now = Date.now();
    for (let i = 0; i < 600; i++) recordTraffic(row(now - i * 1000));
    expect(readTraffic(1000).length).toBe(600);
  });
});

describe("pruning by age", () => {
  it("drops a row older than the window and keeps a fresh one", () => {
    saveSettings({ traffic: { retentionDays: 1 } });
    clearTraffic();
    const now = Date.now();
    recordTraffic(row(now - 2 * DAY, { requested: "old" }));
    recordTraffic(row(now, { requested: "fresh" }));
    expect(readTraffic(100).map((e) => e.requested)).toEqual(["fresh"]);
  });

  it("keeps a row inside the window", () => {
    saveSettings({ traffic: { retentionDays: 1 } });
    clearTraffic();
    const now = Date.now();
    recordTraffic(row(now - 2 * 3_600_000, { requested: "recent" }));
    expect(readTraffic(100).map((e) => e.requested)).toEqual(["recent"]);
  });
});

describe("paging with a cursor", () => {
  it("pages without gaps or repeats", () => {
    saveSettings({ traffic: { retentionDays: 7 } });
    clearTraffic();
    const now = Date.now();
    for (let i = 0; i < 8; i++) recordTraffic(row(now - i * 1000, { requested: `r${i}` }));

    const whole = readTraffic(100);
    expect(whole.length).toBe(8);

    const paged: typeof whole = [];
    let cursor: { ts: number; id: number } | null = null;
    for (;;) {
      const page = readTraffic(3, cursor);
      if (page.length === 0) break;
      paged.push(...page);
      cursor = parseTrafficCursor(trafficCursor(page[page.length - 1]));
      if (page.length < 3) break;
    }
    expect(paged.map((e) => e.id)).toEqual(whole.map((e) => e.id));
    expect(new Set(paged.map((e) => e.id)).size).toBe(8);
  });

  it("does not drop or repeat rows sharing one ts (the boundary millisecond)", () => {
    saveSettings({ traffic: { retentionDays: 7 } });
    clearTraffic();
    const now = Date.now();
    recordTraffic(row(now, { requested: "a" }));
    recordTraffic(row(now, { requested: "b" }));
    recordTraffic(row(now, { requested: "c" }));

    const first = readTraffic(2);
    expect(first.length).toBe(2);
    const second = readTraffic(2, parseTrafficCursor(trafficCursor(first[first.length - 1])));
    const all = [...first, ...second];
    expect(all.length).toBe(3);
    expect(new Set(all.map((e) => e.id)).size).toBe(3);
  });
});

describe("trafficCursor / parseTrafficCursor", () => {
  it("returns null for anything unparseable", () => {
    expect(parseTrafficCursor("abc")).toBeNull();
    expect(parseTrafficCursor("1:")).toBeNull();
    expect(parseTrafficCursor("")).toBeNull();
    expect(parseTrafficCursor(undefined)).toBeNull();
    expect(parseTrafficCursor(null)).toBeNull();
  });

  it("round-trips trafficCursor", () => {
    const c = trafficCursor({ ts: 12345, id: 7 });
    expect(parseTrafficCursor(c)).toEqual({ ts: 12345, id: 7 });
  });
});
