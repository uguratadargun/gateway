import { afterEach, describe, expect, it, vi } from "vitest";

import { createExecution, finishExecution, recordStep } from "@/executions/store";
import { apiEquivalentCost, costForUsage } from "@/lib/pricing";
import { createProvider, getProviderByName } from "@/lib/providers";
import { createTeam, getTeam } from "@/lib/teams";
import { extractRun } from "@/memory/extract";
import { getExtraction } from "@/memory/store";
import { ProviderModelProvider } from "@/providers/direct-provider";
import { createState } from "@/runtime/state";

/**
 * What the recorder's ledger says about a 20k-token prompt when the endpoint
 * caches the prompt: it reports two tokens as input and the rest as a cache
 * write, and the Memory section on the run's page must still say 20k in. The
 * recorder runs on a provider model, which is on nobody's Anthropic bill, so
 * the ledger's price for it is nothing.
 */

const MODEL = "provider:zai/glm-5.3";

function answerWith(usage: Record<string, number>): void {
  if (!getProviderByName("zai")) createProvider({ name: "zai", kind: "anthropic-compat", baseUrl: "https://api.z.ai/api/anthropic", models: ["glm-5.3"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ model: "glm-5.3", content: [{ type: "text", text: JSON.stringify(ANSWER) }], usage }), { status: 200 }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

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

describe("the recorder's ledger when the endpoint caches the prompt", () => {
  it("counts the whole prompt as input", async () => {
    aRun("cache-1");
    answerWith({ input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS, cache_creation_input_tokens: CACHE_WRITE, cache_read_input_tokens: 0 });

    const outcome = await extractRun("cache-1", new ProviderModelProvider(), { model: MODEL });
    expect(outcome).toMatchObject({ status: "done" });

    // The figure the Memory section shows: the prompt the recorder was given.
    const ledger = getExtraction("cache-1")!;
    expect(ledger.inputTokens).toBe(PROMPT_TOKENS);
    expect(ledger.costUsd).toBe(0);
  });

  it("counts a cached re-read as input too", async () => {
    aRun("cache-2");
    answerWith({ input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS, cache_creation_input_tokens: 0, cache_read_input_tokens: CACHE_WRITE });

    const outcome = await extractRun("cache-2", new ProviderModelProvider(), { model: MODEL });
    expect(outcome).toMatchObject({ status: "done" });
    expect(getExtraction("cache-2")!.inputTokens).toBe(PROMPT_TOKENS);
  });
});

describe("the API-equivalent price", () => {
  it("prices a Claude model's cache write apart from its input, and a provider model at nothing", () => {
    const u = { input: INPUT_TOKENS, output: OUTPUT_TOKENS, cacheRead: 0, cacheCreation: CACHE_WRITE };
    expect(apiEquivalentCost("claude-sonnet-5", u)).toBeCloseTo(costForUsage("sonnet", u, { model: "claude-sonnet-5" }), 9);
    expect(apiEquivalentCost("claude-sonnet-5", u)).toBeGreaterThan(costForUsage("sonnet", { ...u, input: PROMPT_TOKENS, cacheCreation: 0 }));
    expect(apiEquivalentCost(MODEL, u)).toBe(0);
  });
});
