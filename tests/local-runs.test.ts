import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { GateClient } from "@/client/api";
import { RunReporter } from "@/client/reporter";
import { resolveRepo } from "@/client/run";
import {
  createExecution,
  failAbandonedLocalExecutions,
  failInterruptedExecutions,
  getExecution,
  isCancelRequested,
  requestExecutionCancel,
  touchExecution,
} from "@/executions/store";
import type { WorkflowEvent } from "@/events/types";
import type { WorkflowDefinition } from "@/workflows/types";

/**
 * Runs that happen somewhere else.
 *
 * The two things that have to hold for a run on a laptop are that the server
 * cannot lose it (a restart here is not a death there) and that it cannot be
 * lost silently (a laptop that stops reporting is settled, not left "running"
 * for ever). Everything else is the reporter, which owes the run one promise:
 * it never fails it.
 */

function fakeClient(report: GateClient["report"]): GateClient {
  return { report } as unknown as GateClient;
}

const event = (type: string): WorkflowEvent => ({ type, at: 1, executionId: "x" }) as WorkflowEvent;

describe("run reporter", () => {
  it("sends what is buffered in one report", async () => {
    const sent: any[] = [];
    const reporter = new RunReporter(
      fakeClient(async (_id, payload) => {
        sent.push(payload);
        return { cancelRequested: false };
      }),
      "run-1",
      () => {},
    );

    reporter.event(event("node.started"));
    reporter.event(event("node.completed"));
    reporter.step({ nodeId: "a", stepIndex: 0, visit: 1, status: "completed", startedAt: 1, finishedAt: 2, input: null, output: null });
    await reporter.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].events).toHaveLength(2);
    expect(sent[0].steps).toHaveLength(1);
  });

  it("keeps a failed report and sends it again rather than losing it", async () => {
    let attempts = 0;
    const sent: any[] = [];
    const reporter = new RunReporter(
      fakeClient(async (_id, payload) => {
        attempts++;
        if (attempts === 1) throw new Error("network went away");
        sent.push(payload);
        return { cancelRequested: false };
      }),
      "run-2",
      () => {},
    );

    reporter.event(event("node.started"));
    await reporter.flush();
    expect(sent).toHaveLength(0);

    reporter.event(event("node.completed"));
    await reporter.flush();
    // Both events arrive, in order: the failed one was not dropped.
    expect(sent[0].events.map((e: WorkflowEvent) => e.type)).toEqual(["node.started", "node.completed"]);
  });

  it("tells the run it was cancelled exactly once", async () => {
    const onCancel = vi.fn();
    const reporter = new RunReporter(
      fakeClient(async () => ({ cancelRequested: true })),
      "run-3",
      onCancel,
    );

    reporter.event(event("node.started"));
    await reporter.flush();
    reporter.event(event("tool.called"));
    await reporter.flush();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("says nothing when there is nothing to say, until the heartbeat is due", async () => {
    const report = vi.fn(async () => ({ cancelRequested: false }));
    const reporter = new RunReporter(fakeClient(report as never), "run-4", () => {});

    await reporter.flush();
    expect(report).not.toHaveBeenCalled();

    // A node can run for a long time without producing an event; the heartbeat
    // is what carries a Stop back to it in the meantime.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(6000);
      vi.setSystemTime(Date.now() + 6000);
      await reporter.flush();
      expect(report).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runs the server does not own", () => {
  it("survives a server restart, unlike a run of its own", () => {
    createExecution("mine", "wf", {}, 1000);
    // Started before this "restart" but still reporting: a laptop mid-run.
    createExecution("theirs", "wf", {}, 1000, null, { origin: "local", teamId: "alpha" });
    touchExecution("theirs", Date.now());

    failInterruptedExecutions(2000, 3000);

    expect(getExecution("mine")!.status).toBe("failed");
    expect(getExecution("theirs")!.status).toBe("running");
  });

  it("settles a local run whose machine stopped reporting", () => {
    const now = 10_000_000;
    createExecution("quiet", "wf", {}, now - 60 * 60_000, null, { origin: "local", teamId: "alpha" });
    createExecution("chatty", "wf", {}, now - 60 * 60_000, null, { origin: "local", teamId: "alpha" });
    // The chatty one reported a moment ago.
    touchExecution("chatty", now - 1000);

    failAbandonedLocalExecutions(now);

    expect(getExecution("quiet")!.status).toBe("failed");
    expect(getExecution("quiet")!.error?.code).toBe("RUN_ABANDONED");
    expect(getExecution("chatty")!.status).toBe("running");
  });

  it("records a stop request for the client to pick up", () => {
    createExecution("stoppable", "wf", {}, Date.now(), null, { origin: "local", teamId: "alpha" });
    expect(isCancelRequested("stoppable")).toBe(false);
    expect(requestExecutionCancel("stoppable")).toBe(true);
    expect(isCancelRequested("stoppable")).toBe(true);
  });
});

describe("which repository a local run works in", () => {
  const workflow = (repo?: string): WorkflowDefinition =>
    ({ workspace: repo ? { repo } : {} }) as unknown as WorkflowDefinition;

  it("prefers the run input, then the pin, then the checkout you are standing in", () => {
    expect(resolveRepo(workflow("/pinned"), { repo: "/given" }, "/anywhere")).toBe("/given");
    expect(resolveRepo(workflow("/pinned"), {}, "/anywhere")).toBe("/pinned");
    // The repository this test file is in resolves to this checkout.
    expect(resolveRepo(workflow(), {}, process.cwd())).toBe(process.cwd());
  });

  it("refuses a connected-repo id this machine has no clone for, and takes one it does", () => {
    // The server resolves `ulak-desktop` to a checkout it manages; here that id
    // means nothing until this machine says which of its clones it is.
    expect(() => resolveRepo(workflow("ulak-desktop"), {}, "/anywhere")).toThrow(/gate repo ulak-desktop/);
    expect(resolveRepo(workflow("ulak-desktop"), {}, "/anywhere", { "ulak-desktop": "/src/ulak" })).toBe("/src/ulak");
  });

  it("says what to do when there is no repository at all", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "gate-not-a-repo-"));
    expect(() => resolveRepo(workflow(), {}, notARepo)).toThrow(/not one|--input repo=/);
  });
});
