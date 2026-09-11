import { describe, expect, it } from "vitest";

import { createTeam, getTeam } from "@/lib/teams";
import { decisionText, dot, featureText, fuseRanks, nearest, storeEmbedding, unembeddedIds, type Embedder } from "@/memory/embeddings";
import { embedMissing, hybridSearchDecisions, hybridSearchFeatures } from "@/memory/hybrid";
import { memoryScopeFor, replaceDecisions, searchFeatures, upsertFeature } from "@/memory/store";

/**
 * Words and vectors together. There is no embedding model in a test, so a
 * stand-in embeds a text as a bag of its words after folding a few synonyms
 * onto one token — enough to show a query that shares no word with a record
 * reaching it through the vector, and the fusion keeping what the words
 * found. The stand-in is the plumbing's test, not the model's.
 */

const SYNONYMS: Record<string, string> = { alerts: "notification", alert: "notification", notify: "notification", notifications: "notification", ping: "notification", buzz: "notification" };
const DIMS = 128;

function hash(word: string): number {
  let h = 2166136261;
  for (const c of word) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Math.abs(h) % DIMS;
}

class BagEmbedder implements Embedder {
  model = "bag-v1";
  calls = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Float32Array(DIMS);
      for (const raw of t.toLowerCase().match(/[a-z]+/g) ?? []) v[hash(SYNONYMS[raw] ?? raw)] += 1;
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      return v.map((x) => x / n);
    });
  }
}

function seed() {
  if (getTeam("hy-org")) return;
  createTeam("Hybrid org", "hy-org");
  upsertFeature({ orgId: "hy-org", name: "Push notifications", aliases: [], summary: "Server-sent notifications delivered to the device." });
  upsertFeature({ orgId: "hy-org", name: "Dark mode", aliases: ["night theme"], summary: "A dark colour scheme." });
  replaceDecisions(
    { executionId: "hy-1", teamId: "hy-org", userId: null, featureId: "push-notifications", baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
    [{ title: "Deliver notifications through the platform push service", context: "", decision: "Use the platform push channel; the app never polls.", rationale: "", alternatives: "", how: "", consequences: "", touches: [{ kind: "area", ref: "push" }] }],
  );
  replaceDecisions(
    { executionId: "hy-2", teamId: "hy-org", userId: null, featureId: "dark-mode", baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 1_000 },
    [{ title: "Follow the system colour scheme", context: "", decision: "Dark mode follows the OS setting.", rationale: "", alternatives: "", how: "", consequences: "", touches: [] }],
  );
}

describe("vectors beside the words", () => {
  it("fuses two rankings so a hit near the top of both wins", () => {
    const fused = fuseRanks([
      ["a", "b", "c"],
      ["c", "a", "d"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0].score).toBeGreaterThan(fused[2].score);
  });

  it("stores unit vectors and finds the nearest among what the scope allows", async () => {
    const e = new BagEmbedder();
    const [a, b] = await e.embed(["alerts on the phone", "dark night theme"]);
    expect(dot(a, a)).toBeCloseTo(1, 5);
    storeEmbedding("feature", "x-alerts", e.model, a);
    storeEmbedding("feature", "x-dark", e.model, b);
    const [q] = await e.embed(["notifications"]);
    expect(nearest("feature", e.model, q, new Set(["x-alerts", "x-dark"]), 2)[0].id).toBe("x-alerts");
    // A scope that does not allow the best match never sees it.
    expect(nearest("feature", e.model, q, new Set(["x-dark"]), 2).map((n) => n.id)).toEqual(["x-dark"]);
  });

  it("embeds what has no vector yet, once, and then finds by meaning what the words miss", async () => {
    seed();
    const scope = memoryScopeFor("hy-org");
    const e = new BagEmbedder();
    expect(unembeddedIds("feature", e.model)).toEqual(expect.arrayContaining(["push-notifications", "dark-mode"]));
    const embedded = await embedMissing(e);
    expect(embedded).toBeGreaterThanOrEqual(3);
    expect(await embedMissing(e)).toBe(0);
    expect(featureText({ name: "A", aliases: ["b"], summary: "c" })).toBe("A\nb\nc");
    expect(decisionText({ title: "t", context: "", decision: "d", how: "", touches: [{ ref: "x.ts" }] })).toBe("t\nd\nx.ts");

    // "alerts" shares no word with the notifications feature: words alone miss it.
    expect(searchFeatures(scope, "alerts on the phone").map((f) => f.id)).not.toContain("push-notifications");
    const hybrid = await hybridSearchFeatures(scope, "alerts on the phone", 5, e);
    expect(hybrid[0]?.id).toBe("push-notifications");
    const decisions = await hybridSearchDecisions(scope, { query: "alerts on the phone" }, e);
    expect(decisions[0]?.executionId).toBe("hy-1");

    // And what the words find stays found: the two rankings are fused, not replaced.
    const both = await hybridSearchDecisions(scope, { query: "system colour scheme" }, e);
    expect(both[0]?.executionId).toBe("hy-2");
  });

  it("answers with the words alone when the embedder fails, and without one", async () => {
    seed();
    const scope = memoryScopeFor("hy-org");
    const broken: Embedder = { model: "bag-v1", embed: async () => { throw new Error("down"); } };
    expect((await hybridSearchDecisions(scope, { query: "colour scheme" }, broken))[0]?.executionId).toBe("hy-2");
    expect((await hybridSearchDecisions(scope, { query: "colour scheme" }, null))[0]?.executionId).toBe("hy-2");
    expect((await hybridSearchFeatures(scope, "dark", 5, null))[0]?.id).toBe("dark-mode");
  });
});
