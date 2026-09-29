import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as eventsRoute } from "@/app/api/v1/executions/[id]/events/route";
import { POST as finishRoute } from "@/app/api/v1/executions/[id]/finish/route";
import { GET as streamRoute } from "@/app/api/v1/executions/stream/route";
import { isExecutionFinished, publishWorkflowEvent, subscribeWorkflow } from "@/events/bus";
import {
  createExecution,
  failAbandonedLocalExecutions,
  finishExecution,
  getExecution,
  pauseExecution,
  recordStep,
  reopenSessionExecution,
  stopSessionExecution,
} from "@/executions/store";
import { createKey, revokeKey } from "@/lib/apikeys";
import { getDb } from "@/lib/db";
import { open, seal } from "@/lib/seal";
import { createTeam, createUser, ensureDefaultTeam, updateUser } from "@/lib/teams";
import { claimExtraction, getExtraction, pendingExtractions, settleExtraction } from "@/memory/store";
import type { StepRecord, WorkflowState } from "@/runtime/state";

/**
 * A run's life on the server after its machine has taken it: reopened,
 * stopped, finished, gone quiet, and watched — each of the places where two of
 * those meet, and one used to undo the other.
 */

let seq = 0;
const fresh = (p: string) => `${p}-${++seq}-${Date.now()}`;

function sessionRun(id: string, userId: string | null = null, teamId = "default") {
  ensureDefaultTeam();
  createExecution(id, "w", {}, Date.now(), null, { origin: "local", driver: "session", teamId, userId });
}

function state(id: string, status: "completed" | "failed", stepCount: number): WorkflowState {
  return {
    executionId: id,
    workflowId: "w",
    status,
    input: {},
    outputs: {},
    visitCounts: {},
    stepCount,
    history: [],
    error: status === "failed" ? { code: "MODEL_EXECUTION_ERROR", message: "it broke" } : null,
  };
}

const step = (nodeId: string, stepIndex: number, status: "completed" | "failed"): StepRecord =>
  ({
    nodeId,
    stepIndex,
    visit: 1,
    status,
    startedAt: 1,
    finishedAt: 2,
    output: status === "completed" ? {} : undefined,
    error: status === "failed" ? { code: "E", message: "e" } : undefined,
  }) as StepRecord;

function person(email: string, teamId = "default") {
  ensureDefaultTeam();
  const user = createUser({ email, teamId });
  const { key, plaintext } = createKey({ name: email, userId: user.id, teamId });
  return { user, key, plaintext };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a run continued after it failed", () => {
  it("is recorded again when it ends, from what it finally did", () => {
    const id = fresh("continued");
    sessionRun(id);
    recordStep(id, step("plan", 0, "completed"));
    recordStep(id, step("impl", 1, "failed"));
    finishExecution(state(id, "failed", 2));
    settleExtraction(id, { status: "done", decisionCount: 1 });

    expect(reopenSessionExecution(id)?.retried).toEqual(["impl"]);
    recordStep(id, step("impl", 1, "completed"));
    finishExecution(state(id, "completed", 2));

    expect(getExtraction(id)?.status).toBe("pending");
    expect(pendingExtractions(500).some((e) => e.executionId === id)).toBe(true);
  });

  it("is not recorded while it is going again", () => {
    const id = fresh("pending-then-reopened");
    sessionRun(id);
    recordStep(id, step("impl", 0, "failed"));
    finishExecution(state(id, "failed", 1));
    expect(getExtraction(id)?.status).toBe("pending");
    // A second path to the same half-run: a row queued by something else while
    // the run is reopened. Neither the drain nor a direct claim takes it.
    reopenSessionExecution(id);
    getDb()
      .prepare("INSERT OR IGNORE INTO memory_extractions (execution_id, team_id, status, version, queued_at) VALUES (?, 'default', 'pending', 1, 1)")
      .run(id);
    expect(pendingExtractions(500).some((e) => e.executionId === id)).toBe(false);
    expect(claimExtraction(id)).toBe(false);
  });

  it("is refused when it ended on its workflow's own give-up, with nothing to try again", () => {
    const id = fresh("gave-up");
    sessionRun(id);
    recordStep(id, step("verifier", 0, "completed"));
    // A failed terminal: the run failed, and its last step is not a failure.
    finishExecution({ ...state(id, "failed", 1), error: null });
    expect(reopenSessionExecution(id)).toBeNull();
    expect(getExecution(id)!.status).toBe("failed");
  });

  it("is reopened when it was stopped with a node in hand", () => {
    const id = fresh("stopped");
    sessionRun(id);
    recordStep(id, step("plan", 0, "completed"));
    stopSessionExecution(id);
    expect(reopenSessionExecution(id)).toEqual({ retried: [] });
    expect(getExecution(id)!.status).toBe("running");
  });

  it("keeps its live stream open on the dashboard after a stop and a continue", () => {
    const id = fresh("bus");
    publishWorkflowEvent({ type: "node.started", executionId: id, at: Date.now(), nodeId: "a", stepIndex: 0, visit: 1 });
    publishWorkflowEvent({ type: "workflow.failed", executionId: id, at: Date.now(), code: "RUN_CANCELLED", message: "stopped" });
    publishWorkflowEvent({ type: "workflow.continued", executionId: id, at: Date.now(), retried: [] });
    expect(isExecutionFinished(id)).toBe(false);
    const seen: string[] = [];
    subscribeWorkflow(id, (e) => seen.push(e.type))();
    expect(seen).toEqual(["node.started", "workflow.continued"]);
  });
});

describe("a finish report and a stop that cross", () => {
  it("leaves the stop standing when it lands while the finish body is on its way", async () => {
    const { user, plaintext } = person(`race-${Date.now()}@x.test`);
    const id = fresh("race");
    sessionRun(id, user.id);

    let push!: (s: string) => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => {
          c.enqueue(new TextEncoder().encode(s));
          c.close();
        };
      },
    });
    const pending = finishRoute(
      new Request(`http://x/api/v1/executions/${id}/finish`, {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}`, "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
      { params: Promise.resolve({ id }) },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(stopSessionExecution(id)).toBe(true);
    push(JSON.stringify({ status: "completed", stepCount: 3 }));

    expect(await (await pending).json()).toEqual({ ok: true, alreadyFinished: true });
    const after = getExecution(id)!;
    expect(after.status).toBe("failed");
    expect(after.error?.code).toBe("RUN_CANCELLED");
  });

  it("never counts a wait as negative when the client's clock runs ahead", () => {
    const stopped = fresh("pause-stop");
    const finished = fresh("pause-finish");
    sessionRun(stopped);
    sessionRun(finished);
    const now = Date.now();
    pauseExecution(stopped, now + 60_000);
    pauseExecution(finished, now + 60_000);
    stopSessionExecution(stopped, now);
    finishExecution(state(finished, "completed", 0), null, now);
    expect(getExecution(stopped)!.pausedMs).toBe(0);
    expect(getExecution(finished)!.pausedMs).toBe(0);
  });
});

describe("a run that reports after a long silence", () => {
  it("is not written off by the very report that shows it is alive", async () => {
    const { user, plaintext } = person(`quiet-${Date.now()}@x.test`);
    const id = fresh("quiet");
    sessionRun(id, user.id);
    // Seven hours without a word: one node took that long.
    getDb().prepare("UPDATE workflow_executions SET last_seen_at = ? WHERE id = ?").run(Date.now() - 7 * 60 * 60_000, id);
    (globalThis as { __gateLocalSweepAt?: number }).__gateLocalSweepAt = undefined;

    const res = await eventsRoute(
      new Request(`http://x/api/v1/executions/${id}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ events: [], steps: [step("impl", 0, "completed")] }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    expect(getExecution(id)!.status).toBe("running");
    // Silence is still silence: a run nobody hears from is written off.
    expect(failAbandonedLocalExecutions(Date.now() + 7 * 60 * 60_000)).toBeGreaterThan(0);
  });
});

describe("the stream of a person's runs", () => {
  it("ends when the key is revoked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { user, key, plaintext } = person(`stream-${Date.now()}@x.test`);
    const id = fresh("stream");
    sessionRun(id, user.id);
    const res = await streamRoute(new Request("http://x/api/v1/executions/stream", { headers: { authorization: `Bearer ${plaintext}` } }));
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("snapshot");

    revokeKey(key.id);
    vi.advanceTimersByTime(15_000);
    publishWorkflowEvent({ type: "node.output", executionId: id, at: Date.now(), nodeId: "a", stepIndex: 0, output: { secret: "after" } });
    expect((await reader.read()).done).toBe(true);
  });

  it("shows a key with no person only the runs that have no owner", async () => {
    ensureDefaultTeam();
    const owner = createUser({ email: `owned-${Date.now()}@x.test`, teamId: "default" });
    const owned = fresh("owned");
    const unowned = fresh("unowned");
    sessionRun(owned, owner.id);
    sessionRun(unowned, null);
    const { plaintext } = createKey({ name: "shared", teamId: "default" });
    const res = await streamRoute(new Request("http://x/api/v1/executions/stream", { headers: { authorization: `Bearer ${plaintext}` } }));
    const reader = res.body!.getReader();
    const snapshot = JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, ""));
    const ids = (snapshot.executions as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(unowned);
    expect(ids).not.toContain(owned);
    await reader.cancel();
  });
});

describe("a person moved to another team mid-run", () => {
  it("can still finish the run they started", async () => {
    createTeam("Elsewhere", "elsewhere");
    const { user, plaintext } = person(`moved-${Date.now()}@x.test`);
    const id = fresh("moved");
    sessionRun(id, user.id);
    updateUser(user.id, { teamId: "elsewhere" });

    const res = await finishRoute(
      new Request(`http://x/api/v1/executions/${id}/finish`, {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ status: "completed", stepCount: 0 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    expect(getExecution(id)!.status).toBe("completed");
    // Filed where it was started.
    expect(getExecution(id)!.teamId).toBe("default");
  });

  it("does not open another person's run on the old team", async () => {
    const { user: other } = person(`stay-${Date.now()}@x.test`);
    const { plaintext } = person(`leaver-${Date.now()}@x.test`);
    const id = fresh("not-mine");
    sessionRun(id, other.id);
    const res = await finishRoute(
      new Request(`http://x/api/v1/executions/${id}/finish`, {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ status: "completed", stepCount: 0 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(403);
  });
});

describe("sealed secrets", () => {
  it("refuse a truncated tag", () => {
    const sealed = seal("provider-key");
    expect(open(sealed)).toBe("provider-key");
    const [iv, tag, enc] = sealed.split(".");
    const short = [iv, Buffer.from(tag, "base64").subarray(0, 4).toString("base64"), enc].join(".");
    expect(() => open(short)).toThrow();
  });
});
