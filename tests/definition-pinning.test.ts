import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { POST as startRun } from "@/app/api/v1/executions/route";
import { deleteAgent, saveAgent } from "@/agents/registry";
import { recordReportedSteps } from "@/executions/record";
import { createExecution, getExecution, listExecutions } from "@/executions/store";
import type { ExecutionRecord } from "@/executions/types";
import { createKey } from "@/lib/apikeys";
import { teamScope, type DefinitionScope } from "@/lib/def-root";
import { createTeam, createUser } from "@/lib/teams";
import { approvalsForExecution, issuesForExecution } from "@/memory/issues";
import type { StepRecord } from "@/runtime/state";
import { deleteWorkflow, saveWorkflow, workflowsDir } from "@/workflows/registry";
import { definitionsHash, pinnedDefinitions, snapshotDefinitions } from "@/workflows/snapshot";

/**
 * What a run is held to, frozen when it starts.
 *
 * The case underneath every test here is the same one: a team edits an agent
 * an hour into somebody's run. Nothing about that edit may change what the
 * run's own reports are judged by — in either direction — and nothing about an
 * edit to an agent the run never used may refuse the run at all.
 */

const PLANNER = `---
name: Pin planner
output:
  type: json
  schema:
    plan: string
    conflictKey: string
    conflicts: "object[]?"
---

Plan the work, and object when another team's decision does not hold here.
`;

// The shipped conflict-review shape: it reads the planner's objection, and its
// output carries the person's answer back.
const GATE = `---
name: Pin gate
asks: approval
inputs: [planner.conflicts, planner.conflictKey, visits.planner]
output:
  type: json
  schema:
    decision: string
    resolved: "object[]"
---

Put the objection to the person and carry back what they say.
`;

const QUIET = `---
name: Pin quiet
output:
  type: json
  schema:
    summary: string
---

Do the work. Objections are no business of yours.
`;

const SPARE = `---
name: Pin spare
---

Nothing in the graph names me.
`;

// The name carries the team so that two teams' identical pipelines do not hash
// the same — a shared hash would let one test's parse answer another's.
const workflowFor = (teamId: string) => `name: Pinned ${teamId}
entry: planner
nodes:
  - id: planner
    type: agent
    agent: pin-planner
    next: gate
  - id: gate
    type: agent
    agent: pin-gate
    next: build
  - id: build
    type: command
    command: [echo, pinned]
    next: quiet
  - id: quiet
    type: agent
    agent: pin-quiet
    next: done
  - id: done
    type: terminal
`;

function install(teamId: string, parentId?: string): DefinitionScope {
  createTeam(teamId, teamId, parentId);
  const scope = teamScope(teamId);
  saveAgent("pin-planner", PLANNER, scope);
  saveAgent("pin-gate", GATE, scope);
  saveAgent("pin-quiet", QUIET, scope);
  saveAgent("pin-spare", SPARE, scope);
  saveWorkflow("pin-flow", workflowFor(teamId), scope);
  return scope;
}

let n = 0;
function run(teamId: string, scope: DefinitionScope | null): ExecutionRecord {
  const id = `pin-run-${++n}`;
  createExecution(id, "pin-flow", {}, 1000, null, {
    teamId,
    definitions: scope ? snapshotDefinitions("pin-flow", scope) : null,
  });
  return getExecution(id)!;
}

function step(over: Partial<StepRecord> & { stepIndex: number; nodeId: string }): StepRecord {
  return { visit: 0, status: "completed", startedAt: 1000, finishedAt: 2000, input: {}, output: {}, ...over } as StepRecord;
}

const conflict = (over: Record<string, unknown> = {}) => ({
  conflictKey: "pin-kem",
  targetTeamId: "pinui",
  title: "the other team's choice does not fit this side",
  decisionSnapshot: "they settled on a hybrid handshake",
  rationale: "our first flight cannot carry the second key share",
  proposal: "move it to the second flight",
  revision: "revise before shipping",
  paths: ["src/crypto"],
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  sourceNodeId: "planner",
  sourceVisit: 0,
  conflictKey: "pin-kem",
  decision: "confirm",
  note: "yes, they are right",
  ...over,
});

describe("the digest a run is started against", () => {
  const scope = install("pinhash");

  it("moves when the workflow itself changes", () => {
    const before = snapshotDefinitions("pin-flow", scope).hash;
    saveWorkflow("pin-flow", workflowFor("pinhash").replace("name: Pinned", "name: Renamed"), scope);
    expect(snapshotDefinitions("pin-flow", scope).hash).not.toBe(before);
  });

  it("moves when an agent the graph names changes", () => {
    const before = snapshotDefinitions("pin-flow", scope).hash;
    saveAgent("pin-quiet", `${QUIET}\nAnd say so in one line.\n`, scope);
    expect(snapshotDefinitions("pin-flow", scope).hash).not.toBe(before);
  });

  it("stays put when an agent the graph never names changes", () => {
    const before = snapshotDefinitions("pin-flow", scope).hash;
    // The whole point: a run must not be refused over an edit to something it
    // never used.
    saveAgent("pin-spare", `${SPARE}\nRewritten from scratch.\n`, scope);
    expect(snapshotDefinitions("pin-flow", scope).hash).toBe(before);
  });

  it("has no digest to agree about for a workflow that will not load", () => {
    expect(definitionsHash("no-such-flow", teamScope("pinhash"))).toBeNull();
  });

  it("records an agent it could not read, and counts it as a difference", () => {
    const gone = install("pinmissing");
    const before = snapshotDefinitions("pin-flow", gone);
    expect(before.missing).toEqual([]);

    deleteAgent("pin-quiet", gone);
    const after = snapshotDefinitions("pin-flow", gone);
    expect(after.missing).toEqual(["pin-quiet"]);
    expect(after.agents["pin-quiet"]).toBeUndefined();
    // Silence about a missing agent would let two sides agree while holding
    // different graphs.
    expect(after.hash).not.toBe(before.hash);
  });

  it("records it on a server that has never loaded that graph before", () => {
    const cold = install("pincold");
    // Written past saveWorkflow, which would refuse a graph naming an agent
    // that is not there, and never read since: nothing about this id has been
    // parsed or cached. That is the state a server is in after a restart, and
    // it is the state the case has to work in — a snapshot that can only be
    // taken because something happened to have loaded the graph earlier is not
    // one a run can rely on.
    writeFileSync(join(workflowsDir(cold), "pin-cold.yaml"), workflowFor("pincold").replace("pin-quiet", "pin-vanished"), {
      mode: 0o600,
    });
    // The run will fail on that node, with a message about the node. The point
    // is that it gets that far with its definitions recorded, rather than
    // being refused at the start over a snapshot that could not be taken.
    expect(snapshotDefinitions("pin-cold", cold).missing).toEqual(["pin-vanished"]);
    expect(definitionsHash("pin-cold", cold)).not.toBeNull();
  });
});

describe("a snapshot read back", () => {
  it("parses to the same graph and agents after the files are gone from disk", () => {
    const scope = install("pinparse");
    const snapshot = snapshotDefinitions("pin-flow", scope);

    deleteWorkflow("pin-flow", scope);
    for (const id of ["pin-planner", "pin-gate", "pin-quiet", "pin-spare"]) deleteAgent(id, scope);
    // Proof the parse below cannot be reading the files: there are none.
    expect(() => snapshotDefinitions("pin-flow", scope)).toThrow();

    const pinned = pinnedDefinitions(snapshot)!;
    expect(pinned.workflow.nodes.map((node) => node.id)).toEqual(["planner", "gate", "build", "quiet", "done"]);
    expect(pinned.node("build")!.type).toBe("command");
    const planner = pinned.agent("pin-planner")!;
    expect(planner.output).toMatchObject({ type: "json" });
    expect(planner.output.type === "json" && "conflicts" in planner.output.schema).toBe(true);
    expect(pinned.agent("pin-gate")!.inputs).toEqual(["planner.conflicts", "planner.conflictKey", "visits.planner"]);
  });
});

describe("a report judged by the run's own definitions", () => {
  createTeam("Pin Org", "pinorg");
  createTeam("Pin UI", "pinui", "pinorg");
  const scope = install("pinsrv", "pinorg");

  it("skips an objection attributed to a node this run's graph does not have", () => {
    const ex = run("pinsrv", scope);
    const out = recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "ghost", output: { conflicts: [conflict()] } })]);
    expect(out.recorded).toBe(1);
    expect(out.issuesRaised).toBe(0);
    expect(out.skipped).toEqual([{ stepIndex: 0, field: "conflicts", reason: 'this run\'s definitions have no node "ghost"' }]);
    expect(issuesForExecution(ex.id)).toHaveLength(0);
  });

  it("skips an objection attributed to a command node", () => {
    const ex = run("pinsrv", scope);
    const out = recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "build", output: { conflicts: [conflict()] } })]);
    expect(out.skipped[0].reason).toMatch(/comes from an agent/);
    expect(issuesForExecution(ex.id)).toHaveLength(0);
  });

  it("skips an objection from an agent whose pinned output never mentions one", () => {
    const ex = run("pinsrv", scope);
    const out = recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "quiet", output: { conflicts: [conflict()] } })]);
    expect(out.skipped[0].reason).toMatch(/does not declare conflicts/);
    expect(issuesForExecution(ex.id)).toHaveLength(0);
  });

  it("writes the objection when the pinned agent declared it", () => {
    const ex = run("pinsrv", scope);
    const out = recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict()] } })]);
    expect(out.issuesRaised).toBe(1);
    expect(out.skipped).toEqual([]);
    expect(issuesForExecution(ex.id).map((i) => i.conflictKey)).toEqual(["pin-kem"]);
  });

  it("skips an answer about a node the reporting node does not read", () => {
    const ex = run("pinsrv", scope);
    const out = recordReportedSteps(ex, [
      step({ stepIndex: 1, nodeId: "gate", output: { resolved: [answer({ sourceNodeId: "quiet" })] } }),
    ]);
    expect(out.approvalsKept).toBe(0);
    expect(out.skipped[0].reason).toMatch(/does not read "quiet"/);
    expect(approvalsForExecution(ex.id)).toHaveLength(0);
  });

  it("keeps an answer about a node the reporting node does read", () => {
    const ex = run("pinsrv", scope);
    const out = recordReportedSteps(ex, [step({ stepIndex: 1, nodeId: "gate", output: { resolved: [answer()] } })]);
    expect(out.approvalsKept).toBe(1);
    expect(out.skipped).toEqual([]);
    expect(approvalsForExecution(ex.id)).toHaveLength(1);
  });

  it("checks nothing at all for a run that started before there were snapshots", () => {
    const ex = run("pinsrv", null);
    const out = recordReportedSteps(ex, [
      step({ stepIndex: 0, nodeId: "a-node-no-graph-has", output: { conflicts: [conflict()] } }),
      step({ stepIndex: 1, nodeId: "another", output: { resolved: [answer()] } }),
    ]);
    expect(out.issuesRaised).toBe(1);
    expect(out.approvalsKept).toBe(1);
    expect(out.skipped).toEqual([]);
  });
});

describe("an agent edited while a run is in flight", () => {
  it("does not change the verdict on that run's own report", () => {
    const scope = install("pinedit", "pinorg");
    const ex = run("pinedit", scope);
    const pinnedHash = snapshotDefinitions("pin-flow", scope).hash;

    // An hour into the run, somebody takes objections out of the planner.
    saveAgent("pin-planner", PLANNER.replace('    conflicts: "object[]?"\n', ""), scope);
    // On disk this run's graph no longer allows what it is about to report.
    expect(snapshotDefinitions("pin-flow", scope).hash).not.toBe(pinnedHash);

    const out = recordReportedSteps(ex, [step({ stepIndex: 0, nodeId: "planner", output: { conflicts: [conflict()] } })]);
    expect(out.skipped).toEqual([]);
    expect(out.issuesRaised).toBe(1);
    expect(issuesForExecution(ex.id).map((i) => i.conflictKey)).toEqual(["pin-kem"]);
  });
});

describe("starting a run against definitions the server does not have", () => {
  const scope = install("pinstart");
  const user = createUser({ email: "dev@pinstart.test", name: "Dev", teamId: "pinstart" });
  const key = createKey({ name: "laptop", userId: user.id, teamId: "pinstart" }).plaintext;

  const start = (body: Record<string, unknown>) =>
    startRun(
      new Request("http://gate.test/api/v1/executions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ workflowId: "pin-flow", ...body }),
      }),
    );

  const mine = () => listExecutions({ teamId: "pinstart", userId: user.id });

  it("refuses the run and starts nothing when the client's digest differs", async () => {
    const res = await start({ definitionsHash: "0123456789abcdef" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "DEFINITIONS_STALE",
      expected: snapshotDefinitions("pin-flow", scope).hash,
      got: "0123456789abcdef",
    });
    expect(mine()).toHaveLength(0);
  });

  it("starts the run when the digest matches", async () => {
    const res = await start({ definitionsHash: snapshotDefinitions("pin-flow", scope).hash });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ definitionsHash: snapshotDefinitions("pin-flow", scope).hash });
    expect(mine()).toHaveLength(1);
  });

  it("starts the run for an older client that claims no digest at all", async () => {
    const res = await start({});
    expect(res.status).toBe(201);
    expect(mine()).toHaveLength(2);
  });
});
