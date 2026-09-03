import { describe, expect, it } from "vitest";

import { currentUtilization, forecastRateLimit, readRateLimit, recordRateLimit } from "@/lib/ratelimit";
import { cheaperTier, loadRoutingConfig, routeModel } from "@/lib/router";

describe("rate limit tracking", () => {
  it("captures raw headers, utilization, and epoch-second resets", () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    recordRateLimit(
      new Headers({
        "anthropic-ratelimit-unified-status": "allowed_warning",
        "anthropic-ratelimit-unified-5h-utilization": "0.82",
        "anthropic-ratelimit-unified-7d-utilization": "0.4",
        "anthropic-ratelimit-unified-reset": String(reset),
      }),
    );
    const s = readRateLimit()!;
    expect(s.unifiedStatus).toBe("allowed_warning");
    expect(s.utilization5h).toBeCloseTo(0.82);
    expect(s.utilization7d).toBeCloseTo(0.4);
    expect(s.resetAt).toBe(reset * 1000);
    expect(s.raw["anthropic-ratelimit-unified-5h-utilization"]).toBe("0.82");
    expect(currentUtilization()).toBeCloseTo(0.82);
  });

  it("forecasts time-to-limit from the utilization slope", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    recordRateLimit(new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.50", "anthropic-ratelimit-unified-reset": String(reset) }));
    await new Promise((r) => setTimeout(r, 30));
    recordRateLimit(new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.60", "anthropic-ratelimit-unified-reset": String(reset) }));
    const f = forecastRateLimit();
    expect(f.utilization).toBeCloseTo(0.6);
    expect(f.etaToLimitMs).not.toBeNull();
    expect(f.etaToLimitMs!).toBeGreaterThan(0);
    expect(f.level).toBe("ok");
  });

  it("flags warning/critical levels", () => {
    recordRateLimit(new Headers({ "anthropic-ratelimit-unified-status": "rejected" }));
    expect(forecastRateLimit().level).toBe("critical");
  });
});

describe("adaptive thinking + throttle helpers", () => {
  it("has per-category effort defaults and exposes the category on routes", () => {
    const cfg = loadRoutingConfig();
    expect(cfg.effort.heavy).toBe("high");
    expect(cfg.effort.trivial).toBe("none");
    const r = routeModel("auto", { messages: [{ role: "user", content: "think hard about it" }] });
    expect(r.category).toBe("heavy");
    expect(routeModel("claude-opus-5", { messages: [] }).category).toBeNull();
  });

  it("walks down the tier ladder", () => {
    expect(cheaperTier("fable")).toBe("opus");
    expect(cheaperTier("opus")).toBe("sonnet");
    expect(cheaperTier("sonnet")).toBe("haiku");
    expect(cheaperTier("haiku")).toBeNull();
  });

  it("honours a tokenOverride for thresholds", () => {
    const r = routeModel("auto", { messages: [{ role: "user", content: "short" }] }, { tokenOverride: 500_000 });
    expect(r.tier).toBe("opus");
    expect(r.reason).toContain("large context");
  });
});
