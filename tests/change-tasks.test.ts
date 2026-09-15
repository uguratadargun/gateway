import { describe, expect, it } from "vitest";

import { recordReportedSteps } from "@/executions/record";
import { createExecution, getExecution } from "@/executions/store";
import { createTeam, teamAncestors } from "@/lib/teams";
import { issuesForTask, liveIssues } from "@/memory/issues";
import { memoryScopeFor } from "@/memory/store";
import { createTask, executionsForTask, getTask, listTasks, setTaskStatus, taskVisibleTo } from "@/orchestration/tasks";
import type { ExecutionRecord } from "@/executions/types";
import type { StepRecord } from "@/runtime/state";

/**
 * The name the work keeps after the runs that served it have ended.
 *
 * A task groups; it does not find. Everything here is checking one boundary
 * from both sides: a run that names a task is filed under it, and a run that
 * names none is not thereby lost — the objection it raised still reaches the
 * team it was raised against, because paths and features are what carry it.
 */

function tree() {
  if (!teamAncestors("ulak").length) {
    createTeam("Ulak", "ulak");
    createTeam("Desktop", "desktop", "ulak");
    createTeam("Other Co", "otherco");
  }
  if (!teamAncestors("srv").length) createTeam("Server", "srv", "ulak");
}

let n = 0;
function run(teamId: string, taskId: string | null = null): ExecutionRecord {
  tree();
  const id = `task-run-${teamId}-${++n}`;
  createExecution(id, "dev", {}, 1000, null, { teamId, taskId });
  return getExecution(id)!;
}

function objectionStep(key: string): StepRecord {
  return {
    stepIndex: 0,
    nodeId: "planner",
    visit: 0,
    status: "completed",
    startedAt: 1000,
    finishedAt: 2000,
    input: {},
    output: {
      conflicts: [
        {
          conflictKey: key,
          targetTeamId: "desktop",
          title: "the KEM choice does not fit the server handshake",
          decisionSnapshot: "X25519+Kyber768 hybrid in the client",
          rationale: "our handshake cannot carry the second key share in the first flight",
          proposal: "move the share to the second flight",
          revision: "revise the client handshake before shipping",
          paths: ["src/crypto"],
        },
      ],
    },
  } as StepRecord;
}

describe("a task outlives the runs that serve it", () => {
  it("files a run and its objections under the task, and leaves both findable without one", () => {
    tree();
    const task = createTask({ teamId: "ulak", title: "post-quantum handshake" });
    expect(task.status).toBe("open");

    const filed = run("srv", task.id);
    recordReportedSteps(filed, [objectionStep("pq-filed")]);

    // The same work, reported by somebody who never opened a task.
    const loose = run("srv");
    expect(loose.taskId).toBeNull();
    recordReportedSteps(loose, [objectionStep("pq-loose")]);

    expect(executionsForTask(task.id).map((e) => e.id)).toEqual([filed.id]);
    expect(issuesForTask(task.id).map((i) => i.conflictKey)).toEqual(["pq-filed"]);

    // And the boundary that matters: desktop reads both. A task is a label on
    // the objection, never the thing that finds it.
    const seen = liveIssues(memoryScopeFor("desktop"), { paths: ["src/crypto"] }).map((i) => i.conflictKey);
    expect(seen).toContain("pq-filed");
    expect(seen).toContain("pq-loose");
  });

  it("carries the task onto the objection, so the task can show what is unsettled", () => {
    tree();
    const task = createTask({ teamId: "ulak", title: "handshake revision" });
    const ex = run("srv", task.id);
    recordReportedSteps(ex, [objectionStep("pq-stamped")]);

    const [issue] = issuesForTask(task.id);
    expect(issue.taskId).toBe(task.id);
    expect(issue.fromTeamId).toBe("srv");
    expect(issue.targetTeamId).toBe("desktop");
  });

  it("shows a team its family's tasks and nobody else's", () => {
    tree();
    const ours = createTask({ teamId: "ulak", title: "ours" });
    const theirs = createTask({ teamId: "otherco", title: "theirs" });

    const visible = listTasks("desktop").map((t) => t.id);
    expect(visible).toContain(ours.id);
    expect(visible).not.toContain(theirs.id);

    // A task outside the family is not refused with a reason that admits it
    // exists: from here it simply is not a task.
    expect(taskVisibleTo(ours.id, "desktop")).not.toBeNull();
    expect(taskVisibleTo(theirs.id, "desktop")).toBeNull();
  });

  it("is closed by a person, not by a run ending", () => {
    tree();
    const task = createTask({ teamId: "ulak", title: "still going" });
    const ex = run("srv", task.id);
    recordReportedSteps(ex, [objectionStep("pq-open")]);

    // The run is over. The work it served is not.
    expect(getTask(task.id)!.status).toBe("open");
    expect(listTasks("srv").map((t) => t.id)).toContain(task.id);

    expect(setTaskStatus(task.id, "done")).toBe(true);
    expect(getTask(task.id)!.status).toBe("done");
    expect(listTasks("srv").map((t) => t.id)).not.toContain(task.id);
    // Closing it does not withdraw what was raised under it.
    expect(issuesForTask(task.id).map((i) => i.conflictKey)).toEqual(["pq-open"]);
  });
});
