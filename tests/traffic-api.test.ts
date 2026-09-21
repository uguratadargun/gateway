import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { GET as exportGET } from "@/app/api/export/route";
import { GET as trafficGET } from "@/app/api/traffic/route";
import { clearTraffic, recordTraffic } from "@/lib/traffic";

/**
 * `/api/traffic` and `/api/export`'s shared filter contract: both readers of
 * `readTraffic` take the same five parameters, a bad one is refused rather
 * than silently ignored, and the CSV header stays in the order the export
 * depends on.
 */

const previousHome = process.env.GATE_HOME;

beforeAll(() => {
  process.env.GATE_HOME = mkdtempSync(join(tmpdir(), "gate-traffic-api-"));
});
afterAll(() => {
  process.env.GATE_HOME = previousHome;
});

afterEach(() => {
  clearTraffic();
});

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

describe("GET /api/traffic", () => {
  it("returns every row plus a facets object when nothing is filtered", async () => {
    recordTraffic(row({ ts: 1, requestId: "r1", userId: "u-1" }));
    recordTraffic(row({ ts: 2, requestId: "r2", keyId: "local" }));

    const res = await trafficGET(new Request("http://x/api/traffic"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entries).toHaveLength(2);
    expect(body.facets.tiers).toContain("sonnet");
  });

  it("narrows to one person's rows", async () => {
    recordTraffic(row({ ts: 1, requestId: "r1", userId: "u-1" }));
    recordTraffic(row({ ts: 2, requestId: "r2", userId: "u-2" }));

    const res = await trafficGET(new Request("http://x/api/traffic?person=user:u-1"));
    const body = await res.json();
    expect(body.entries.map((e: any) => e.requestId)).toEqual(["r1"]);
  });

  it("returns exactly the row a request id names", async () => {
    recordTraffic(row({ ts: 1, requestId: "r1" }));
    recordTraffic(row({ ts: 2, requestId: "r2" }));

    const res = await trafficGET(new Request("http://x/api/traffic?request=r2"));
    const body = await res.json();
    expect(body.entries.map((e: any) => e.requestId)).toEqual(["r2"]);
  });

  it("refuses a nonsense person, served, or tier by naming the parameter", async () => {
    const person = await trafficGET(new Request("http://x/api/traffic?person=nonsense"));
    expect(person.status).toBe(400);
    expect((await person.json()).error).toContain("person");

    const served = await trafficGET(new Request("http://x/api/traffic?served=nonsense"));
    expect(served.status).toBe(400);
    expect((await served.json()).error).toContain("served");

    const tier = await trafficGET(new Request("http://x/api/traffic?tier=nonsense"));
    expect(tier.status).toBe(400);
    expect((await tier.json()).error).toContain("tier");
  });
});

describe("GET /api/export?what=traffic", () => {
  it("filters by tier and keeps the CSV header's order, with the new columns appended", async () => {
    recordTraffic(row({ ts: 1, requestId: "r1", tier: "sonnet" }));
    recordTraffic(row({ ts: 2, requestId: "r2", tier: "opus" }));

    const res = await exportGET(new Request("http://x/api/export?what=traffic&format=csv&tier=opus"));
    const text = await res.text();
    const [header, ...lines] = text.trim().split("\n");

    expect(
      header.startsWith(
        "ts,endpoint,requested,routed,tier,status,stream,fromCache,requestPreview,responsePreview,accountId,providerId,keyId,userId,teamId,caller,servedBy,team",
      ),
    ).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("r2");
  });
});
