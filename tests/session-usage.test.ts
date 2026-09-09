import { describe, expect, it } from "vitest";

import {
  attributeSessionUsage,
  createExecution,
  finishExecution,
  getExecution,
  getExecutionSteps,
  recordStep,
  reopenSessionExecution,
} from "@/executions/store";
import { recordUsage } from "@/lib/usage";
import { createState } from "@/runtime/state";

/**
 * Two things the server does for a run a session drives that the engine
 * never needed.
 *
 * The nodes the session does itself cost something, and the run used to show
 * them as free: the session's own gateway calls are filed under the session's
 * id, so the run records that id and the calls inside a step's minutes are
 * summed against the step. And a failed run can be reopened at the node that
 * failed: the failed attempt leaves the history, everything before it stays.
 */

const local = { origin: "local" as const, driver: "session" as const };

describe("costing the nodes a session did itself", () => {
  it("sums the session's calls inside the step's window, across models, and marks the figure as attributed", () => {
    createExecution("exec-sess-1", "dev", { task: "x" }, 10_000, null, {
      ...local,
      client: { host: "laptop", repo: null, branch: null, version: null, session: "sess-abc" },
    });
    expect(getExecution("exec-sess-1")?.client?.session).toBe("sess-abc");

    // Before the step, inside it (two models), after it, and another session's.
    recordUsage({ ts: 10_500, requested: "opus", model: "claude-opus-5", tier: "opus", reason: "r", status: 200, stream: false, inputTokens: 100, outputTokens: 10, sessionId: "sess-abc" });
    recordUsage({ ts: 11_000, requested: "opus", model: "claude-opus-5", tier: "opus", reason: "r", status: 200, stream: false, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, sessionId: "sess-abc" });
    recordUsage({ ts: 11_500, requested: "haiku", model: "claude-haiku-4-5-20251001", tier: "haiku", reason: "r", status: 200, stream: false, inputTokens: 300, outputTokens: 20, sessionId: "sess-abc" });
    recordUsage({ ts: 11_600, requested: "opus", model: "claude-opus-5", tier: "opus", reason: "r", status: 529, stream: false, inputTokens: 999, outputTokens: 0, sessionId: "sess-abc" });
    recordUsage({ ts: 11_700, requested: "opus", model: "claude-opus-5", tier: "opus", reason: "r", status: 200, stream: false, inputTokens: 5000, outputTokens: 500, sessionId: "sess-other" });
    recordUsage({ ts: 12_500, requested: "opus", model: "claude-opus-5", tier: "opus", reason: "r", status: 200, stream: false, inputTokens: 100, outputTokens: 10, sessionId: "sess-abc" });

    recordStep("exec-sess-1", {
      nodeId: "clarify",
      stepIndex: 0,
      visit: 1,
      startedAt: 11_000,
      finishedAt: 12_000,
      status: "completed",
      input: null,
      output: { answers: "blue" },
    });
    const usage = attributeSessionUsage("exec-sess-1", 0);
    expect(usage).toMatchObject({ model: "claude-opus-5", inputTokens: 1300, outputTokens: 220, cacheReadTokens: 50, source: "session" });
    expect(usage!.costUsd!).toBeGreaterThan(0);

    const [stored] = getExecutionSteps("exec-sess-1");
    expect(stored.usage).toMatchObject({ model: "claude-opus-5", inputTokens: 1300, source: "session" });
    expect(stored.usage?.costUsd).toBeCloseTo(usage!.costUsd!, 10);
    // Once: a step that has usage is not re-attributed.
    expect(attributeSessionUsage("exec-sess-1", 0)).toBeNull();

    // The run's own total takes the exact figure, not a re-pricing of the dominant model.
    const state = createState("exec-sess-1", "dev", { task: "x" });
    state.stepCount = 1;
    state.status = "completed";
    finishExecution(state, null, 13_000);
    expect(getExecution("exec-sess-1")?.quota?.costUsd).toBeCloseTo(usage!.costUsd!, 10);
  });

  it("attributes nothing for a run that does not know its session, or a window with no calls", () => {
    createExecution("exec-sess-2", "dev", {}, 20_000, null, { ...local, client: { host: "laptop", repo: null, branch: null, version: null } });
    recordStep("exec-sess-2", { nodeId: "a", stepIndex: 0, visit: 1, startedAt: 20_000, finishedAt: 21_000, status: "completed", input: null, output: {} });
    expect(attributeSessionUsage("exec-sess-2", 0)).toBeNull();

    createExecution("exec-sess-3", "dev", {}, 30_000, null, { ...local, client: { host: "h", repo: null, branch: null, version: null, session: "quiet" } });
    recordStep("exec-sess-3", { nodeId: "a", stepIndex: 0, visit: 1, startedAt: 30_000, finishedAt: 31_000, status: "completed", input: null, output: {} });
    expect(attributeSessionUsage("exec-sess-3", 0)).toBeNull();
    expect(getExecutionSteps("exec-sess-3")[0].usage).toBeNull();
  });
});

describe("reopening a failed session-driven run", () => {
  it("drops the trailing failed attempt, keeps everything before it, and sets the run running", () => {
    createExecution("exec-reopen-1", "dev", { task: "x" }, 1000, null, local);
    recordStep("exec-reopen-1", { nodeId: "base", stepIndex: 0, visit: 1, startedAt: 1000, finishedAt: 1001, status: "completed", input: null, output: { ok: true } });
    recordStep("exec-reopen-1", { nodeId: "planner", stepIndex: 1, visit: 1, startedAt: 1001, finishedAt: 1500, status: "completed", input: null, output: { plan: "p" } });
    recordStep("exec-reopen-1", {
      nodeId: "implementer",
      stepIndex: 2,
      visit: 1,
      startedAt: 1500,
      finishedAt: 1600,
      status: "failed",
      input: null,
      output: null,
      error: { code: "MODEL_EXECUTION_ERROR", message: "the worker died" },
    });
    const state = createState("exec-reopen-1", "dev", { task: "x" });
    state.stepCount = 3;
    state.status = "failed";
    state.error = { code: "MODEL_EXECUTION_ERROR", message: "the worker died" };
    finishExecution(state, null, 1600);
    expect(getExecution("exec-reopen-1")?.status).toBe("failed");

    expect(reopenSessionExecution("exec-reopen-1", 2000)).toEqual({ retried: ["implementer"] });
    const run = getExecution("exec-reopen-1")!;
    expect(run.status).toBe("running");
    expect(run.error).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.stepCount).toBe(2);
    expect(run.lastSeenAt).toBe(2000);
    expect(getExecutionSteps("exec-reopen-1").map((s) => s.nodeId)).toEqual(["base", "planner"]);
  });

  it("is not for a run that is still going, finished cleanly, or driven by an engine", () => {
    createExecution("exec-reopen-2", "dev", {}, 1000, null, local);
    expect(reopenSessionExecution("exec-reopen-2")).toBeNull();

    createExecution("exec-reopen-3", "dev", {}, 1000, null, local);
    const done = createState("exec-reopen-3", "dev", {});
    done.status = "completed";
    finishExecution(done, null, 1100);
    expect(reopenSessionExecution("exec-reopen-3")).toBeNull();

    createExecution("exec-reopen-4", "dev", {}, 1000, null, { origin: "local", driver: "engine" });
    const failed = createState("exec-reopen-4", "dev", {});
    failed.status = "failed";
    failed.error = { code: "X", message: "x" };
    finishExecution(failed, null, 1100);
    expect(reopenSessionExecution("exec-reopen-4")).toBeNull();
  });
});
