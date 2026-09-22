import { describe, expect, it } from "vitest";

import { loadSettings, saveSettings } from "@/lib/settings";
import { settingsPatchSchema } from "@/lib/schemas";

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
