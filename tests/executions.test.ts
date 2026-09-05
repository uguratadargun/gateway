import { describe, expect, it } from "vitest";

import { publishWorkflowEvent, subscribeWorkflow, workflowEvents } from "@/events/bus";
import {
  createExecution,
  deleteExecution,
  finishExecution,
  getExecution,
  getExecutionLineage,
  getExecutionSteps,
  getLayout,
  getResumedAs,
  listExecutions,
  recordStep,
  saveLayout,
  setExecutionWorkspace,
} from "@/executions/store";
import { createState } from "@/runtime/state";

describe("execution store", () => {
  it("persists a run, its steps and its outcome", () => {
    const state = createState("exec-store-1", "dev", { branch: "main" });
    createExecution(state.executionId, state.workflowId, state.input, 1000);
    recordStep(state.executionId, {
      nodeId: "planner",
      stepIndex: 0,
      visit: 1,
      startedAt: 1000,
      finishedAt: 1200,
      status: "completed",
      input: { a: 1 },
      output: { plan: "p" },
      usage: { model: "claude-sonnet-5", inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 },
    });
    state.stepCount = 1;
    state.status = "failed";
    state.error = { code: "LOOP_LIMIT_EXCEEDED", message: "too many" };
    finishExecution(state, null, 2000);

    const rec = getExecution("exec-store-1")!;
    expect(rec).toMatchObject({ workflowId: "dev", status: "failed", startedAt: 1000, finishedAt: 2000, stepCount: 1 });
    expect(rec.input).toEqual({ branch: "main" });
    expect(rec.error).toEqual({ code: "LOOP_LIMIT_EXCEEDED", message: "too many" });

    const steps = getExecutionSteps("exec-store-1");
    expect(steps).toHaveLength(1);
    expect(steps[0].output).toEqual({ plan: "p" });
    expect(steps[0].usage?.model).toBe("claude-sonnet-5");

    expect(listExecutions({ workflowId: "dev" }).map((e) => e.id)).toContain("exec-store-1");
    expect(deleteExecution("exec-store-1")).toBe(true);
    expect(getExecutionSteps("exec-store-1")).toHaveLength(0);
  });

  it("walks a chain of resumes into one ordered lineage", () => {
    // Root run: two steps, then stopped.
    createExecution("lineage-root", "dev", { task: "x" }, 1000);
    setExecutionWorkspace("lineage-root", {
      root: "/tmp/w",
      repo: "/tmp/repo",
      branch: "gate/run-a",
      baseRef: "HEAD",
      commit: "aaa",
      changedFiles: ["a.ts"],
    });
    recordStep("lineage-root", {
      nodeId: "planner",
      stepIndex: 0,
      visit: 1,
      startedAt: 1000,
      finishedAt: 1100,
      status: "completed",
      input: null,
      output: { plan: "p" },
    });
    recordStep("lineage-root", {
      nodeId: "implementation",
      stepIndex: 1,
      visit: 1,
      startedAt: 1100,
      finishedAt: 1200,
      status: "failed",
      input: null,
      output: null,
      error: { code: "RUN_CANCELLED", message: "run cancelled" },
    });

    // First resume: one more step, then stopped again.
    createExecution("lineage-mid", "dev", { task: "x" }, 1300, "lineage-root");
    setExecutionWorkspace("lineage-mid", {
      root: "/tmp/w",
      repo: "/tmp/repo",
      branch: "gate/run-a",
      baseRef: "HEAD",
      commit: "bbb",
      changedFiles: ["a.ts", "b.ts"],
    });
    recordStep("lineage-mid", {
      nodeId: "implementation",
      stepIndex: 2, // continues the cumulative count seeded from the root
      visit: 2,
      startedAt: 1300,
      finishedAt: 1400,
      status: "completed",
      input: null,
      output: { diff: "d" },
    });

    // Second resume, still in progress.
    createExecution("lineage-tip", "dev", { task: "x" }, 1500, "lineage-mid");

    const lineage = getExecutionLineage("lineage-tip")!;
    expect(lineage.workflowId).toBe("dev");
    expect(lineage.input).toEqual({ task: "x" });
    // Oldest step first, across both ancestors, nothing from "lineage-tip" yet.
    expect(lineage.steps.map((s) => `${s.nodeId}:${s.status}`)).toEqual([
      "planner:completed",
      "implementation:failed",
      "implementation:completed",
    ]);
    // The nearest ancestor's workspace record wins — same worktree, fresher commit.
    expect(lineage.workspace?.commit).toBe("bbb");
    expect(lineage.workspace?.changedFiles).toEqual(["a.ts", "b.ts"]);

    expect(getResumedAs("lineage-root")).toEqual(["lineage-mid"]);
    expect(getResumedAs("lineage-mid")).toEqual(["lineage-tip"]);
    expect(getExecution("lineage-tip")!.resumedFrom).toBe("lineage-mid");
    expect(getExecution("lineage-root")!.resumedFrom).toBeNull();

    for (const id of ["lineage-root", "lineage-mid", "lineage-tip"]) deleteExecution(id);
  });

  it("has nothing to walk for an execution that started fresh", () => {
    createExecution("lineage-solo", "dev", {}, 1000);
    const lineage = getExecutionLineage("lineage-solo")!;
    expect(lineage.steps).toHaveLength(0);
    expect(lineage.workspace).toBeNull();
    deleteExecution("lineage-solo");
  });

  it("stores node layout separately from the workflow definition", () => {
    expect(getLayout("dev")).toEqual({});
    saveLayout("dev", { planner: { x: 10, y: 20 } });
    saveLayout("dev", { planner: { x: 30, y: 40 } });
    expect(getLayout("dev")).toEqual({ planner: { x: 30, y: 40 } });
  });
});

describe("workflow event bus", () => {
  it("replays buffered events to a late subscriber", () => {
    publishWorkflowEvent({ type: "workflow.started", executionId: "bus-1", at: 1, workflowId: "dev", entry: "planner" });
    publishWorkflowEvent({ type: "node.started", executionId: "bus-1", at: 2, nodeId: "planner", stepIndex: 0, visit: 1 });

    const seen: string[] = [];
    const unsub = subscribeWorkflow("bus-1", (e) => seen.push(e.type));
    expect(seen).toEqual(["workflow.started", "node.started"]);

    publishWorkflowEvent({ type: "workflow.completed", executionId: "bus-1", at: 3, status: "completed", terminalNodeId: "done" });
    expect(seen).toEqual(["workflow.started", "node.started", "workflow.completed"]);
    unsub();

    publishWorkflowEvent({ type: "node.started", executionId: "bus-1", at: 4, nodeId: "x", stepIndex: 1, visit: 1 });
    expect(seen).toHaveLength(3);
    expect(workflowEvents("bus-1")).toHaveLength(4);
  });

  it("keeps executions isolated from one another", () => {
    const a: string[] = [];
    subscribeWorkflow("bus-a", (e) => a.push(e.type));
    publishWorkflowEvent({ type: "node.started", executionId: "bus-b", at: 1, nodeId: "n", stepIndex: 0, visit: 1 });
    expect(a).toHaveLength(0);
  });
});
