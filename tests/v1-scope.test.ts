import { describe, expect, it } from "vitest";

import { GET as listRuns } from "@/app/api/v1/executions/route";
import { GET as readRun } from "@/app/api/v1/executions/[id]/route";
import { POST as cancelRun } from "@/app/api/v1/executions/[id]/cancel/route";
import { GET as streamRuns } from "@/app/api/v1/executions/stream/route";
import { publishWorkflowEvent } from "@/events/bus";
import { createExecution } from "@/executions/store";
import { createKey } from "@/lib/apikeys";
import { createTeam, createUser } from "@/lib/teams";

/**
 * The client API shows a person their own runs.
 *
 * A key names a person; what that person lists, reads, stops and streams
 * through `/api/v1` is what they started. The team's runs together are the
 * dashboard's view, behind the admin login — a cockpit on a developer's
 * machine, holding only their key, must not be handed a teammate's run.
 */

createTeam("Sigma", "sigma");
const ann = createUser({ email: "ann@sigma.test", name: "Ann", teamId: "sigma" });
const bob = createUser({ email: "bob@sigma.test", name: "Bob", teamId: "sigma" });
const annKey = createKey({ name: "ann laptop", userId: ann.id, teamId: "sigma" }).plaintext;
const bobKey = createKey({ name: "bob laptop", userId: bob.id, teamId: "sigma" }).plaintext;

// Started just now: a session-driven run that has not reported for hours is
// written off as abandoned, and a snapshot only carries what is still running.
const now = Date.now();
createExecution("run-ann", "dev", { task: "ann's" }, now - 2, null, { origin: "local", driver: "session", userId: ann.id, teamId: "sigma" });
createExecution("run-bob", "dev", { task: "bob's" }, now - 1, null, { origin: "local", driver: "session", userId: bob.id, teamId: "sigma" });

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (key: string, url = "http://gate.test/api/v1/executions", init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });

describe("a person's runs on the client API", () => {
  it("lists only what they started", async () => {
    const mine = (await (await listRuns(as(annKey))).json()) as { executions: Array<{ id: string }> };
    expect(mine.executions.map((e) => e.id)).toEqual(["run-ann"]);
    const theirs = (await (await listRuns(as(bobKey))).json()) as { executions: Array<{ id: string }> };
    expect(theirs.executions.map((e) => e.id)).toEqual(["run-bob"]);
  });

  it("reads and stops only their own", async () => {
    expect((await readRun(as(annKey), params("run-ann"))).status).toBe(200);
    expect((await readRun(as(annKey), params("run-bob"))).status).toBe(403);
    expect((await cancelRun(as(annKey, "http://gate.test/api/v1/executions/run-bob/cancel", { method: "POST" }), params("run-bob"))).status).toBe(403);
  });

  it("streams a snapshot of their unfinished runs, then only their events", async () => {
    const abort = new AbortController();
    const res = await streamRuns(as(annKey, "http://gate.test/api/v1/executions/stream", { signal: abort.signal }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const frames: Array<Record<string, unknown>> = [];
    const readFrame = async () => {
      const { value, done } = await reader.read();
      if (done) return;
      for (const line of decoder.decode(value).split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
      }
    };

    await readFrame();
    expect(frames[0]).toMatchObject({ type: "snapshot" });
    expect((frames[0].executions as Array<{ id: string }>).map((e) => e.id)).toEqual(["run-ann"]);

    publishWorkflowEvent({ type: "run.paused", executionId: "run-bob", at: 3_000, nodeId: "plan-review" });
    publishWorkflowEvent({ type: "run.paused", executionId: "run-ann", at: 3_001, nodeId: "clarify" });
    await readFrame();
    expect(frames.slice(1)).toEqual([{ type: "run.paused", executionId: "run-ann", at: 3_001, nodeId: "clarify" }]);

    abort.abort();
  });
});
