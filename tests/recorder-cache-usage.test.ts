import { describe, expect, it, vi } from "vitest";

const executeMessages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/gateway-core", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  executeMessages,
}));

import { createExecution, finishExecution, recordStep } from "@/executions/store";
import { costForUsage } from "@/lib/pricing";
import { createTeam, getTeam } from "@/lib/teams";
import { extractRun } from "@/memory/extract";
import { getExtraction } from "@/memory/store";
import { GateModelProvider } from "@/providers/gate-provider";
import { createState } from "@/runtime/state";

/**
 * What the recorder's ledger says about a 20k-token prompt when prompt
 * caching is on: the API bills two tokens as input and the rest as a cache
 * write, and the Memory section on the run's page must still say 20k in, for
 * the price the gateway itself recorded.
 */

const ANSWER = {
  decisions: [
    {
      title: "Queue edits locally, flush on connectivity",
      context: "Edits were lost offline.",
      decision: "A local queue table takes every edit; a worker flushes it when online.",
      rationale: "Survives process death.",
      alternatives: "In-memory buffer: rejected.",
      how: "edit → queue row → worker → ack → delete.",
      consequences: "Per-entity ordering only.",
      touches: [{ kind: "file", ref: "app/sync/Queue.kt" }],
      supersedes: null,
    },
  ],
  feature: null,
};

const PROMPT_TOKENS = 20_000;
const INPUT_TOKENS = 2;
const CACHE_WRITE = PROMPT_TOKENS - INPUT_TOKENS;
const OUTPUT_TOKENS = 400;

function aRun(id: string) {
  if (!getTeam("acme")) createTeam("Acme", "acme");
  const state = createState(id, "dev", { task: "Add offline sync so edits survive losing the network" });
  createExecution(id, "dev", state.input, 1_000, null, { teamId: "acme", userId: "u-1" });
  recordStep(id, {
    nodeId: "implementer", stepIndex: 0, visit: 1, startedAt: 1_100, finishedAt: 1_900, status: "completed", input: {},
    output: { summary: "Added a queue table and a flush worker.", changed: true },
  });
  state.stepCount = 1;
  state.status = "completed";
  finishExecution(
    state,
    { root: "/tmp/x", repo: "/tmp/r", branch: "gate/sync", baseRef: "main", baseCommit: "abc123", commit: "def456", changedFiles: ["app/sync/Queue.kt"] },
    2_000,
  );
}

describe("the recorder's ledger with prompt caching on", () => {
  it("counts the whole prompt as input and prices the cache write", async () => {
    aRun("cache-1");
    executeMessages.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "claude-sonnet-5",
          content: [{ type: "text", text: JSON.stringify(ANSWER) }],
          usage: {
            input_tokens: INPUT_TOKENS,
            output_tokens: OUTPUT_TOKENS,
            cache_creation_input_tokens: CACHE_WRITE,
            cache_read_input_tokens: 0,
          },
        }),
        { status: 200, headers: { "x-gate-model": "claude-sonnet-5" } },
      ),
    );

    const outcome = await extractRun("cache-1", new GateModelProvider(), { model: "sonnet" });
    expect(outcome).toMatchObject({ status: "done" });

    const ledger = getExtraction("cache-1")!;
    // The figure the Memory section shows: the prompt the recorder was given.
    expect(ledger.inputTokens).toBe(PROMPT_TOKENS);
    // The price the gateway's own usage row charges for the same call: a 5m
    // cache write bills at 1.25× input, not 1×.
    const exact = costForUsage(
      "sonnet",
      { input: INPUT_TOKENS, output: OUTPUT_TOKENS, cacheRead: 0, cacheCreation: CACHE_WRITE },
      { model: "claude-sonnet-5", cacheTtl: "5m" },
    );
    expect(ledger.costUsd).toBeCloseTo(exact, 6);
  });

  it("counts a cached re-read as input too, at the cache-read price", async () => {
    aRun("cache-2");
    executeMessages.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "claude-sonnet-5",
          content: [{ type: "text", text: JSON.stringify(ANSWER) }],
          usage: {
            input_tokens: INPUT_TOKENS,
            output_tokens: OUTPUT_TOKENS,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: CACHE_WRITE,
          },
        }),
        { status: 200, headers: { "x-gate-model": "claude-sonnet-5" } },
      ),
    );

    const outcome = await extractRun("cache-2", new GateModelProvider(), { model: "sonnet" });
    expect(outcome).toMatchObject({ status: "done" });

    const ledger = getExtraction("cache-2")!;
    expect(ledger.inputTokens).toBe(PROMPT_TOKENS);
    const exact = costForUsage(
      "sonnet",
      { input: INPUT_TOKENS, output: OUTPUT_TOKENS, cacheRead: CACHE_WRITE, cacheCreation: 0 },
      { model: "claude-sonnet-5", cacheTtl: "5m" },
    );
    expect(ledger.costUsd).toBeCloseTo(exact, 6);
  });
});
