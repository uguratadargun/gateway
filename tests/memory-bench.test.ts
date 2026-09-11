import { describe, expect, it } from "vitest";

import { createTeam, getTeam } from "@/lib/teams";
import { memoryScopeFor, replaceDecisions, searchDecisions, searchFeatures, upsertFeature } from "@/memory/store";

/**
 * How the memory tables behave at the size they are meant for — many teams,
 * hundreds of features each, a few decisions per feature — measured rather
 * than asserted. Off by default: it seeds tens of thousands of rows.
 *
 *   GATE_BENCH=1 npx vitest run tests/memory-bench.test.ts
 *
 * Prints p50/p99 for a text search, a path search, a catalogue search and a
 * write that lands while reads are going. The numbers are the exit criterion
 * for keeping this on SQLite; see the memory design notes.
 */

const TEAMS = Number(process.env.GATE_BENCH_TEAMS ?? 20);
const FEATURES_PER_TEAM = Number(process.env.GATE_BENCH_FEATURES ?? 500);
const DECISIONS_PER_FEATURE = Number(process.env.GATE_BENCH_DECISIONS ?? 5);

const WORDS = (
  "sync queue retry backoff auth token session login logout cache invalidation pagination cursor offset search index " +
  "upload download resume chunk notification push badge theme dark light layout grid list detail settings preference " +
  "export import csv pdf print share deep link route guard permission role admin audit log metric trace crash report " +
  "database migration schema column index transaction lock conflict merge crdt timestamp clock drift timezone locale"
).split(" ");

function pick(rng: () => number, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rng() * WORDS.length)]);
  return out;
}

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function timed<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const out = fn();
  return [out, performance.now() - t0];
}

describe.skipIf(!process.env.GATE_BENCH)("memory at scale", () => {
  it("searches tens of thousands of decisions in milliseconds", { timeout: 0 }, () => {
    const rng = mulberry(42);
    if (!getTeam("bench-org")) {
      createTeam("Bench org", "bench-org");
      for (let t = 0; t < TEAMS; t++) createTeam(`Bench ${t}`, `bench-${t}`, "bench-org");
    }
    const [, seedMs] = timed(() => {
      for (let t = 0; t < TEAMS; t++) {
        const team = `bench-${t}`;
        for (let f = 0; f < FEATURES_PER_TEAM; f++) {
          const name = `${pick(rng, 2).join(" ")} ${t}-${f}`;
          const feature = upsertFeature({ orgId: "bench-org", name, aliases: pick(rng, 1), summary: pick(rng, 12).join(" ") });
          replaceDecisions(
            { executionId: `bench-${t}-${f}`, teamId: team, userId: null, featureId: feature.id, baseCommit: "a", headCommit: "b", outcome: "shipped", validFrom: 1_000 + f },
            Array.from({ length: DECISIONS_PER_FEATURE }, (_, d) => ({
              title: `${pick(rng, 3).join(" ")} ${d}`,
              context: pick(rng, 20).join(" "),
              decision: pick(rng, 25).join(" "),
              rationale: pick(rng, 15).join(" "),
              alternatives: pick(rng, 10).join(" "),
              how: pick(rng, 60).join(" "),
              consequences: pick(rng, 12).join(" "),
              touches: [
                { kind: "file" as const, ref: `src/${WORDS[f % WORDS.length]}/${WORDS[(f * 7 + d) % WORDS.length]}.ts` },
                { kind: "area" as const, ref: WORDS[f % WORDS.length] },
              ],
            })),
          );
        }
      }
    });
    const total = TEAMS * FEATURES_PER_TEAM * DECISIONS_PER_FEATURE;
    const scope = memoryScopeFor("bench-3");

    const text: number[] = [];
    const paths: number[] = [];
    const catalogue: number[] = [];
    const writes: number[] = [];
    for (let i = 0; i < 200; i++) {
      const q = pick(rng, 4).join(" ");
      const [hits, ms] = timed(() => searchDecisions(scope, { query: q, limit: 20 }));
      text.push(ms);
      expect(hits.length).toBeGreaterThan(0);
      const [, pms] = timed(() => searchDecisions(scope, { paths: [`src/${WORDS[i % WORDS.length]}`], limit: 20 }));
      paths.push(pms);
      const [, cms] = timed(() => searchFeatures(scope, q, 8));
      catalogue.push(cms);
      if (i % 20 === 0) {
        const [, wms] = timed(() =>
          replaceDecisions(
            { executionId: `bench-live-${i}`, teamId: "bench-3", userId: null, featureId: null, baseCommit: null, headCommit: null, outcome: "shipped", validFrom: 5_000 },
            Array.from({ length: 3 }, (_, d) => ({ title: `live ${i} ${d}`, context: pick(rng, 20).join(" "), decision: pick(rng, 25).join(" "), rationale: "", alternatives: "", how: pick(rng, 60).join(" "), consequences: "", touches: [] })),
          ),
        );
        writes.push(wms);
      }
    }
    const line = (label: string, s: number[]) => `${label.padEnd(22)} p50 ${percentile(s, 50).toFixed(2)} ms · p99 ${percentile(s, 99).toFixed(2)} ms · max ${Math.max(...s).toFixed(2)} ms`;
    console.log(
      [
        `memory bench: ${TEAMS} teams × ${FEATURES_PER_TEAM} features × ${DECISIONS_PER_FEATURE} decisions = ${total} decisions, seeded in ${(seedMs / 1000).toFixed(1)} s`,
        line("text search (fts5)", text),
        line("path search (touches)", paths),
        line("catalogue search", catalogue),
        line("write (3 decisions)", writes),
      ].join("\n"),
    );
    expect(percentile(text, 99)).toBeLessThan(500);
  });
});
