import { describe, expect, it } from "vitest";

import { DEFAULT_AGENTS } from "@/agents/defaults";
import { parseAgent } from "@/agents/loader";
import type { AgentDefinition } from "@/agents/types";
import { createTeam, getTeam } from "@/lib/teams";
import { LocalMemoryAccess, describeSearch } from "@/memory/access";
import { replaceDecisions, upsertFeature, upsertImplementation } from "@/memory/store";
import { runWorkflow } from "@/runtime/engine";
import { parseSince } from "@/runtime/tools/memory-tools";
import { parseWorkflow } from "@/workflows/loader";

import { FakeModelProvider, toolUse } from "./fakes/fake-model-provider";

/**
 * The recall node, through the engine: the shipped agent, the two memory
 * tools, and a scope that is the run's team and nothing the model says.
 */

const meta = { sourcePath: "/tmp/x", updatedAt: 0 };
const loadAgent = (id: string): AgentDefinition => parseAgent(id, DEFAULT_AGENTS[id], meta);

const WORKFLOW = `
name: Recall only
entry: recall
nodes:
  - id: recall
    type: agent
    agent: recall
    next: done
  - id: done
    type: terminal
`;

function seed() {
  if (getTeam("rc-ulak")) return;
  createTeam("Ulak", "rc-ulak");
  createTeam("Android", "rc-android", "rc-ulak");
  createTeam("Desktop", "rc-desktop", "rc-ulak");
  createTeam("Elsewhere", "rc-other");
  const f = upsertFeature({ orgId: "rc-ulak", name: "Offline sync", aliases: ["background sync"], summary: "Local queue, flushed when online." });
  replaceDecisions(
    { executionId: "rc-run-1", teamId: "rc-android", userId: null, featureId: f.id, baseCommit: "a1", headCommit: "b2", outcome: "shipped", validFrom: Date.now() - 86_400_000 },
    [
      {
        title: "Queue edits in a local table",
        context: "",
        decision: "Every edit is queued locally and flushed by a worker.",
        rationale: "Survives process death.",
        alternatives: "",
        how: "edit → queue row → worker → ack → delete.",
        consequences: "Per-entity ordering only.",
        touches: [{ kind: "file", ref: "app/sync/Queue.kt" }, { kind: "area", ref: "sync" }],
      },
    ],
  );
  upsertImplementation({ featureId: f.id, teamId: "rc-android", summary: "Room queue + WorkManager.", pitfalls: "Ordering is per entity." });
  replaceDecisions(
    { executionId: "rc-run-2", teamId: "rc-other", userId: null, featureId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
    [{ title: "Offline sync with CRDTs", context: "", decision: "CRDT merge.", rationale: "", alternatives: "", how: "", consequences: "", touches: [] }],
  );
}

describe("the recall node", () => {
  it("searches memory as the run's team and briefs the planner from what it found", async () => {
    seed();
    const provider = new FakeModelProvider((_req, i) => {
      if (i === 0) return { toolUses: [toolUse("memory_search", { query: "offline sync for desktop edits" }, "tu_1")] };
      if (i === 1) return { toolUses: [toolUse("memory_feature", { id: "offline-sync" }, "tu_2")] };
      if (i === 2) return { toolUses: [toolUse("memory_search", { paths: ["app/sync"], since: "30d" }, "tu_3")] };
      return JSON.stringify({ brief: "Same feature elsewhere: rc-android built Offline sync (offline-sync).", sources: ["offline-sync"] });
    });
    const state = await runWorkflow(parseWorkflow("w", WORKFLOW, meta), {
      provider,
      loadAgent,
      memory: new LocalMemoryAccess("rc-desktop"),
      input: { task: "Add offline sync to the desktop app" },
    });
    expect(state.error).toBeNull();
    expect(state.status).toBe("completed");
    expect(state.outputs.recall).toMatchObject({ sources: ["offline-sync"] });

    // The engine appends to one message list, so the last call holds every
    // tool result; read them by the id each tool use was given.
    const results = (id: string) => {
      for (const m of provider.calls.at(-1)!.messages) {
        if (typeof m.content === "string") continue;
        for (const block of m.content) if (block.type === "tool_result" && block.toolUseId === id) return block;
      }
      throw new Error(`no result for ${id}`);
    };
    // The sibling team's decision and the catalogue entry, with ids; the
    // other tree's decision about the same words is not in the answer.
    expect(results("tu_1").isError).toBe(false);
    expect(results("tu_1").content).toContain("offline-sync — Offline sync (also: background sync) · built by: rc-android");
    expect(results("tu_1").content).toContain("Queue edits in a local table");
    expect(results("tu_1").content).toContain("team: rc-android");
    expect(results("tu_1").content).not.toContain("CRDT");
    expect(results("tu_2").content).toContain("Room queue + WorkManager.");
    expect(results("tu_2").content).toContain("pitfalls: Ordering is per entity.");
    expect(results("tu_3").content).toContain("app/sync/Queue.kt");
    expect(results("tu_3").content).toContain("commits a1..b2");
    // The agent's prompt carries the task, and the memory tools were offered
    // with no workspace at all.
    expect(String(provider.calls[0].messages[0].content)).toContain("Add offline sync to the desktop app");
    expect(provider.calls[0].tools?.map((t) => t.name)).toEqual(["memory_search", "memory_feature"]);
  });

  it("tells the model when memory is out of reach, rather than failing the node", async () => {
    seed();
    const provider = new FakeModelProvider((_req, i) => {
      if (i === 0) return { toolUses: [toolUse("memory_search", { query: "anything" }, "tu_1")] };
      return JSON.stringify({ brief: "Nothing found.", sources: [] });
    });
    const state = await runWorkflow(parseWorkflow("w", WORKFLOW, meta), { provider, loadAgent, input: { task: "x" } });
    expect(state.status).toBe("completed");
    const last = provider.calls[1].messages.at(-1)!.content as Array<{ content: string; isError?: boolean }>;
    expect(last[0].isError).toBe(true);
    expect(last[0].content).toMatch(/not reachable/);
  });

  it("says plainly when nothing matches, and reads times the way people write them", async () => {
    seed();
    const empty = await new LocalMemoryAccess("rc-desktop").search({ query: "payment gateway chargeback" });
    expect(describeSearch(empty)).toMatch(/Nothing in memory matches/);
    const now = Date.UTC(2026, 8, 10);
    expect(parseSince("30d", now)).toBe(now - 30 * 86_400_000);
    expect(parseSince("6 months", now)).toBe(now - 180 * 86_400_000);
    expect(parseSince("2026-05-01", now)).toBe(Date.UTC(2026, 4, 1));
    expect(parseSince("soon", now)).toBeNull();
  });

  it("keeps another tree's catalogue closed", async () => {
    seed();
    expect(await new LocalMemoryAccess("rc-other").feature("offline-sync")).toBeNull();
    expect((await new LocalMemoryAccess("rc-android").feature("offline-sync"))?.implementations.map((i) => i.team)).toEqual(["rc-android"]);
  });
});
