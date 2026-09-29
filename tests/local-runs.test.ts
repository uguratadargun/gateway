import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRepo } from "@/client/repo";
import {
  createExecution,
  failAbandonedLocalExecutions,
  failInterruptedExecutions,
  getExecution,
  isCancelRequested,
  requestExecutionCancel,
  touchExecution,
} from "@/executions/store";
import type { WorkflowDefinition } from "@/workflows/types";

/**
 * Runs that happen somewhere else.
 *
 * The two things that have to hold for a run on a laptop are that the server
 * cannot lose it (a restart here is not a death there) and that it cannot be
 * lost silently (a laptop that stops reporting is settled, not left "running"
 * for ever).
 */

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
