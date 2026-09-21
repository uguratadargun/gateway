import { afterEach, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { clearTraffic, readTraffic, recordTraffic, trafficFacets } from "@/lib/traffic";

/**
 * `readTraffic`'s filters and facets, and the run/node it resolves a row to —
 * all against rows inserted directly, the way `tests/storage.test.ts` does.
 */

const row = (over: Partial<Parameters<typeof recordTraffic>[0]> = {}) => ({
  ts: 1,
  endpoint: "messages",
  requested: "a",
  routed: "m",
  tier: "sonnet",
  status: 200,
  stream: false,
  fromCache: false,
  requestPreview: "q",
  responsePreview: "r",
  requestId: "r0",
  ...over,
});

afterEach(() => {
  clearTraffic();
});

describe("filtering the traffic log", () => {
  it("narrows by person, served-by, tier, and request id, and intersects when combined", () => {
    recordTraffic(row({ ts: 1, requestId: "r1", userId: "u-1", tier: "sonnet", accountId: "a-1" }));
    recordTraffic(row({ ts: 2, requestId: "r2", userId: "u-2", tier: "opus", accountId: "a-2" }));
    recordTraffic(row({ ts: 3, requestId: "r3", keyId: "local", tier: "opus", providerId: "p-1" }));

    expect(readTraffic({ person: "user:u-1" }).map((r) => r.requestId)).toEqual(["r1"]);
    expect(readTraffic({ person: "key:local" }).map((r) => r.requestId)).toEqual(["r3"]);
    expect(readTraffic({ served: "account:a-1" }).map((r) => r.requestId)).toEqual(["r1"]);
    expect(readTraffic({ served: "provider:p-1" }).map((r) => r.requestId)).toEqual(["r3"]);
    expect(readTraffic({ tier: "opus" }).map((r) => r.requestId).sort()).toEqual(["r2", "r3"]);
    expect(readTraffic({ tier: "opus", served: "provider:p-1" }).map((r) => r.requestId)).toEqual(["r3"]);
    expect(readTraffic({ requestId: "r2" }).map((r) => r.requestId)).toEqual(["r2"]);
    expect(readTraffic().map((r) => r.requestId)).toEqual(["r3", "r2", "r1"]);
  });
});

describe("the facets a filter bar offers", () => {
  it("lists each person once, a deleted account's row still, and only tiers that occur", () => {
    recordTraffic(row({ ts: 1, requestId: "r1", userId: "u-1", tier: "sonnet", accountId: "gone-account" }));
    recordTraffic(row({ ts: 2, requestId: "r2", userId: "u-1", tier: "sonnet", accountId: "gone-account" }));
    recordTraffic(row({ ts: 3, requestId: "r3", keyId: "local", tier: "haiku" }));

    const facets = trafficFacets();
    expect(facets.people.filter((p) => p.value === "user:u-1")).toHaveLength(1);
    expect(facets.people.map((p) => p.value)).toContain("key:local");
    const account = facets.served.find((s) => s.value === "account:gone-account");
    expect(account?.label).toMatch(/^removed account /);
    expect(facets.tiers.sort()).toEqual(["haiku", "sonnet"]);
    expect(facets.tiers).not.toContain("opus");
  });
});

describe("a row names the run and the node it came from", () => {
  it("resolves the node open when the row happened, and degrades honestly otherwise", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO workflow_executions (id, workflow_id, status, started_at, finished_at) VALUES (?,?,?,?,?)",
    ).run("exec-1", "dev", "done", 0, 1000);
    db.prepare(
      "INSERT INTO workflow_execution_steps (execution_id, step_index, node_id, visit, status, started_at, finished_at) VALUES (?,?,?,?,?,?,?)",
    ).run("exec-1", 0, "planner", 1, "done", 0, 100);
    db.prepare(
      "INSERT INTO workflow_execution_steps (execution_id, step_index, node_id, visit, status, started_at, finished_at) VALUES (?,?,?,?,?,?,?)",
    ).run("exec-1", 1, "implementer", 1, "done", 200, 300);

    recordTraffic(row({ ts: 50, requestId: "r-in-first", executionId: "exec-1" }));
    recordTraffic(row({ ts: 250, requestId: "r-in-second", executionId: "exec-1" }));
    recordTraffic(row({ ts: 150, requestId: "r-between", executionId: "exec-1" }));
    recordTraffic(row({ ts: 999, requestId: "r-no-execution" }));

    const byId = new Map(readTraffic().map((r) => [r.requestId, r]));
    expect(byId.get("r-in-first")).toMatchObject({ workflowId: "dev", nodeId: "planner" });
    expect(byId.get("r-in-second")).toMatchObject({ workflowId: "dev", nodeId: "implementer" });
    expect(byId.get("r-between")).toMatchObject({ workflowId: "dev", nodeId: null, executionId: "exec-1" });
    expect(byId.get("r-no-execution")).toMatchObject({ workflowId: null, nodeId: null, executionId: null });
  });
});
