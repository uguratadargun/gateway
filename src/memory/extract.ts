import { z } from "zod";

import { getExecution, getExecutionDiff, getExecutionLineage } from "@/executions/store";
import type { ExecutionRecord, ExecutionStepRecord } from "@/executions/types";
import { costForUsage, tierOf } from "@/lib/pricing";
import { loadSettings } from "@/lib/settings";
import type { ModelProvider } from "@/providers/types";

import { hybridSearchDecisions, hybridSearchFeatures } from "./hybrid";
import {
  claimExtraction,
  getImplementation,
  memoryScopeFor,
  replaceDecisions,
  searchDecisions,
  settleExtraction,
  upsertFeature,
  upsertImplementation,
} from "./store";
import { TEACH_WORKFLOW_ID, type DecisionOutcome, type Extraction, type FeatureHit } from "./types";

/**
 * The recorder: reads what a run's nodes produced and writes what was decided.
 *
 * It is a server-side job, not a node in the workflow, and that is deliberate.
 * A node at the end of the graph never runs for a run that was stopped or
 * that failed on its last step — exactly the runs whose decisions ("we tried
 * X, the reviewer refused it because Y") the next planner most needs. The
 * server already holds every step the run reported, so the recorder reads
 * those, after the run has settled, however it settled. What the person sees
 * is the ledger row on the run's page: attempted, done, or failed with why,
 * and what it cost.
 */

const NODE_ID = "memory-recorder";

/** How much of one step's output the recorder reads; a plan can run to pages. */
const MAX_STEP_CHARS = 12_000;
/** A taught branch's account stands in for every agent of a run at once. */
const MAX_TAUGHT_STEP_CHARS = 50_000;
/** And of the whole run. */
const MAX_TOTAL_CHARS = 120_000;
/** One decision record or design doc is read whole; a page of prose is plenty, code pasted into it is not the record. */
const MAX_DOC_CHARS = 6_000;
/** The documents are the team's own account and come first, but half the room stays for what the agents said. */
const MAX_DOCS_CHARS = MAX_TOTAL_CHARS / 2;
/** The files the repository keeps as its record: one decision, or one feature as it stands. Nothing else in docs/ is one. */
const DOC_PATH = /^docs\/(decisions|design)\/[^/]+\.md$/;
/**
 * The recorder's own answer: a feature, an implementation summary and up to
 * thirty decisions, each with context, rationale, alternatives and
 * consequences. At 16k this ran out mid-array on a richly taught branch and
 * the truncation was reported as a formatting fault, so nothing was recorded.
 */
const MAX_RECORDER_OUTPUT_TOKENS = 48_000;

const touchSchema = z.object({ kind: z.enum(["file", "area"]).default("file"), ref: z.string().min(1).max(500) });

const draftSchema = z.object({
  title: z.string().min(1).max(200),
  context: z.string().max(4000).default(""),
  decision: z.string().max(4000).default(""),
  rationale: z.string().max(4000).default(""),
  alternatives: z.string().max(4000).default(""),
  how: z.string().max(8000).default(""),
  consequences: z.string().max(4000).default(""),
  touches: z.array(touchSchema).max(100).default([]),
  supersedes: z.string().max(100).nullish(),
});

const answerSchema = z.object({
  decisions: z.array(draftSchema).max(30).default([]),
  feature: z
    .object({
      /** The id of a catalogue entry this run's work belongs to, or null for a new one / none. */
      match: z.string().max(100).nullish(),
      name: z.string().max(120).default(""),
      aliases: z.array(z.string().max(120)).max(20).default([]),
      /** One platform-free sentence on what the feature is: the catalogue's own line. */
      description: z.string().max(600).default(""),
      /** This team's implementation, as it stands after this run. */
      summary: z.string().max(4000).default(""),
      pitfalls: z.string().max(4000).default(""),
    })
    .nullish(),
});

export type RecorderAnswer = z.infer<typeof answerSchema>;

export interface ExtractionOutcome {
  status: "done" | "failed" | "skipped";
  reason?: string;
  decisionCount: number;
}

/** The model's answer as JSON: the whole text, or the object inside a fence or prose. */
export function parseRecorderAnswer(text: string): RecorderAnswer {
  const attempts = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1));
  let lastError: unknown = null;
  for (const candidate of attempts) {
    try {
      return answerSchema.parse(JSON.parse(candidate));
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`the recorder did not answer in the shape asked for: ${lastError instanceof Error ? lastError.message.split("\n")[0] : "not JSON"}`);
}

/** Paths a unified diff touches, when the run's own list is empty. */
export function pathsInDiff(diff: string | null): string[] {
  if (!diff) return [];
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) out.add(m[2]);
  return [...out].slice(0, 200);
}

/**
 * The decision records and design docs a run wrote, read out of its diff.
 *
 * Only the added lines: a deleted record is not a decision this run made, and
 * for an edited design doc the new lines are what changed, which is what the
 * recorder is told they are. A rename or mode change with no added lines
 * carries nothing to read and is left out.
 */
export function docsInDiff(diff: string | null): Array<{ path: string; text: string }> {
  if (!diff) return [];
  const out: Array<{ path: string; text: string }> = [];
  for (const block of diff.split(/^(?=diff --git )/m)) {
    const header = block.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!header) continue;
    const path = header[2];
    if (!DOC_PATH.test(path)) continue;
    if (/^\+\+\+ \/dev\/null$/m.test(block)) continue;
    const hunk = block.indexOf("\n@@");
    if (hunk < 0) continue;
    const added = block
      .slice(hunk + 1)
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(1));
    if (!added.length) continue;
    out.push({ path, text: added.join("\n") });
    if (out.length >= 20) break;
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… [truncated at ${max} characters]` : s;
}

/**
 * The steps worth reading: agents that answered, in the order they ran.
 *
 * The recall node's answer is left out: it is memory read back, not a
 * decision, and a run that got no further than recall — stopped there, or a
 * recall-only check — has nothing to record and costs no model call.
 */
export function readableSteps(steps: ExecutionStepRecord[]): ExecutionStepRecord[] {
  return steps.filter(
    (s) =>
      s.output !== null &&
      s.output !== undefined &&
      typeof s.output === "object" &&
      !("stdout" in (s.output as object)) &&
      !("brief" in (s.output as object) && "sources" in (s.output as object)),
  );
}

/**
 * How far this run's work got, said only as far as the run's own steps prove
 * it.
 *
 * The merge-request node pushes the branch and opens the request; nothing in
 * gate watches whether anyone merged it, and nothing watches a deploy. So the
 * best this can honestly return is `pr-open`, and a pipeline with no merge
 * node at all — a review, an investigation, a run whose whole job was to read
 * — only proves it `completed`. Both used to be recorded as `shipped`, which
 * a planner on a sibling team reads as "this is live, build on it".
 */
export function outcomeOf(execution: ExecutionRecord, steps: ExecutionStepRecord[]): DecisionOutcome {
  if (execution.status !== "completed") return "abandoned";
  // A taught branch is the one case where a person is asserting how far the
  // work got — it is their claim and not gate's observation, which is why it
  // is `shipped` and not `merged`. A teaching that says the branch is not
  // finished is taken at its word too: `in-progress`, so the sibling planner
  // that finds it objects now rather than building on a choice still moving.
  if (execution.workflowId === TEACH_WORKFLOW_ID) {
    return execution.input?.wip === true ? "in-progress" : "shipped";
  }
  const merge = steps.filter((s) => s.nodeId === "merge-request");
  if (!merge.length) return "completed";
  const opened = merge.some((s) => s.status === "completed" && (s.output as { ok?: boolean } | null)?.ok === true);
  return opened ? "pr-open" : "unshipped";
}

export const RECORDER_SYSTEM = `You are the recorder of an engineering team's memory. A run of an agent workflow has just ended; you are given what it was asked to do, what each of its agents answered, how it ended, and what it touched. You write the record the team keeps of it: what was decided, why, and how — at the level of logic, never code.

Write for the engineer who opens this a month from now asking "why is it like this" or "how did they build this", and for the planner on a sibling team asked to build the same thing on another platform. They will not have the diff. They will have your words.

Rules:
- Logic, not code. Describe flows, states, invariants, trade-offs, the shape of the data. Never paste code, never describe syntax. A file path is fine as a pointer; a function body is not.
- One decision per real choice. A run that did one thing has one decision; a run that chose a storage model, a retry policy and a conflict rule has three. Do not pad. A run that changed nothing, or was stopped before it decided anything, has zero decisions — say so with an empty list.
- A run that failed or was stopped still made decisions: record what was tried and why it did not ship, with the reviewer's or verifier's reason in "consequences". That is often the most useful record of all.
- An investigation (a "blame" run) that established a cause is a decision too: title it "Cause of <symptom>", put the cause in "decision" with its certainty stated in the first words (suspected / confirmed / verified), the evidence in "rationale", the proposed fix in "how", and name the decision it found at fault in "supersedes" only when the cause was confirmed. An investigation that found nothing related has no decisions.
- "how" is the part that lets someone rebuild it elsewhere: the sequence, the components and what each is responsible for, the edge cases handled and how, the ones deliberately not handled.
- "touches" lists the files and areas the decision lives in, as paths relative to the repository root and short area names (e.g. "sync", "auth"). Take the paths from the run's changed files where they apply, and from the record's Touches section.
- "supersedes" names an earlier decision id, only when this run replaced one of the earlier decisions you are shown and you are sure.
- When the run wrote a decision record (a file under docs/decisions/ in "Documents the run wrote"), that record is the decision: produce exactly one decision for it and take title, context, decision, rationale, alternatives, how and consequences from its sections of the same names, close to verbatim — tighten to fit the field limits, do not rewrite, do not add choices the record does not make. Put the record's own path in "touches" as a file touch, alongside the paths its Touches section lists. Its Supersedes line becomes "supersedes" only when it names one of the earlier decision ids shown; otherwise null. Other real choices the run made that no record covers are still separate decisions.
- When the run wrote a design doc (docs/design/), take the feature's summary from its Summary and How it works sections and its pitfalls from its Pitfalls section, updated with what this run changed; the doc is the team's own statement and outranks your reading of the steps.
- The feature: pick the catalogue entry this work belongs to, by id, when one of the candidates is the same feature under any name; otherwise name a new one — short, product-level ("Offline sync", "Login with SSO"), not a task title — or null when the run was housekeeping that belongs to no feature. Give it a one-sentence, platform-free description of what the feature is for the catalogue. Then write this team's implementation summary as it stands after this run: a few sentences that would let a sibling team plan the same feature, and its pitfalls as a separate field. If a previous summary is shown, update it rather than restarting.

Answer with one JSON object and nothing else — no prose before or after, no code fence:
{
  "decisions": [
    {
      "title": "...",
      "context": "...",
      "decision": "...",
      "rationale": "...",
      "alternatives": "...",
      "how": "...",
      "consequences": "...",
      "touches": [{"kind": "file" | "area", "ref": "..."}],
      "supersedes": "<decision id>" | null
    }
  ],
  "feature": {
    "match": "<catalogue id>" | null,
    "name": "...",
    "aliases": ["..."],
    "description": "...",
    "summary": "...",
    "pitfalls": "..."
  } | null
}`;

/** Everything the recorder is shown about one run, as one message. */
export function recorderPrompt(input: {
  execution: ExecutionRecord;
  steps: ExecutionStepRecord[];
  changedFiles: string[];
  docs: Array<{ path: string; text: string }>;
  candidates: FeatureHit[];
  previous: Array<{ id: string; title: string; decision: string; teamId: string }>;
  implementationsSoFar: Array<{ featureId: string; summary: string; pitfalls: string }>;
}): string {
  const { execution, steps } = input;
  const taught = execution.workflowId === TEACH_WORKFLOW_ID;
  const stepChars = taught ? MAX_TAUGHT_STEP_CHARS : MAX_STEP_CHARS;
  const parts: string[] = [];
  parts.push(`# The run\n`);
  if (taught) {
    parts.push(
      "This is not a run of a workflow. It is work finished before the team recorded its runs, taught to memory from its branch: " +
        'the "teach" step is an engineer\'s session\'s account of that branch, read from its commits, its diff and the code, ' +
        'and "commits" is the branch\'s own history. Record it as you would a run that shipped. Where the account says a reason ' +
        "was inferred rather than stated, keep that uncertainty in your words; do not invent alternatives it does not name.\n",
    );
  }
  parts.push(`Workflow: ${execution.workflowId}`);
  parts.push(`Team: ${execution.teamId}${execution.userId ? ` · run by user ${execution.userId}` : ""}`);
  parts.push(`Ended: ${execution.status}${execution.error ? ` — ${execution.error.code}: ${execution.error.message}` : ""}`);
  if (execution.workspace) {
    parts.push(`Branch: ${execution.workspace.branch} · from ${execution.workspace.baseCommit ?? execution.workspace.baseRef} to ${execution.workspace.commit ?? "(uncommitted)"}`);
  }
  parts.push(`\n## What it was asked\n`);
  for (const [k, v] of Object.entries(execution.input)) parts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

  // The documents take their room first: they are the team's own record of
  // the work, and a long run must not crowd them out.
  let budget = MAX_TOTAL_CHARS;
  if (input.docs.length) {
    parts.push(`\n## Documents the run wrote\n`);
    parts.push(
      "These are the team's own record of this work, written in the same branch as the code. A file under docs/decisions is one decision; " +
        "a file under docs/design describes the feature as it now stands. A few added lines mean an edit to an existing document, not a new record.\n",
    );
    let docsBudget = MAX_DOCS_CHARS;
    for (const doc of input.docs) {
      const text = truncate(doc.text, MAX_DOC_CHARS);
      if (docsBudget <= 0) {
        parts.push(`### ${doc.path}\n[omitted, the run wrote many documents]\n`);
        continue;
      }
      const shown = text.length > docsBudget ? truncate(text, docsBudget) : text;
      docsBudget -= shown.length;
      budget -= shown.length;
      parts.push(`### ${doc.path}\n${shown}\n`);
    }
  }

  parts.push(`\n## What its agents answered, in order\n`);
  for (const s of steps) {
    const text = truncate(JSON.stringify(s.output, null, 2), stepChars);
    if (budget <= 0) {
      parts.push(`[${s.nodeId} · visit ${s.visit}: omitted, the run is long]`);
      continue;
    }
    const shown = text.length > budget ? truncate(text, budget) : text;
    budget -= shown.length;
    parts.push(`### ${s.nodeId} · visit ${s.visit} · ${s.status}\n${shown}\n`);
  }

  parts.push(`\n## Files the run changed\n`);
  parts.push(input.changedFiles.length ? input.changedFiles.join("\n") : "(none recorded)");

  parts.push(`\n## Catalogue candidates this work may belong to\n`);
  parts.push(
    input.candidates.length
      ? input.candidates
          .map((f) => `- ${f.id}: ${f.name}${f.aliases.length ? ` (also: ${f.aliases.join(", ")})` : ""} — ${f.summary || "(no summary)"} — built by: ${f.teams.join(", ") || "nobody yet"}`)
          .join("\n")
      : "(the catalogue has nothing like it yet)",
  );
  if (input.implementationsSoFar.length) {
    parts.push(`\n## This team's implementation summary so far\n`);
    for (const impl of input.implementationsSoFar) parts.push(`- ${impl.featureId}: ${impl.summary}\n  pitfalls: ${impl.pitfalls || "(none)"}`);
  }
  parts.push(`\n## Earlier decisions in the same areas (for "supersedes")\n`);
  parts.push(input.previous.length ? input.previous.map((d) => `- ${d.id} [${d.teamId}] ${d.title}: ${d.decision}`).join("\n") : "(none)");
  return parts.join("\n");
}

/**
 * Records one run, if it is this call's to record.
 *
 * Claims the ledger row first — so two servers, or a retry racing the first
 * try, cannot both write — and settles it whatever happens: done with the
 * count, failed with the reason, or skipped when there was nothing to read.
 */
export async function extractRun(executionId: string, provider: ModelProvider, opts: { model: string; now?: () => number } ): Promise<ExtractionOutcome | null> {
  const now = opts.now ?? Date.now;
  if (!claimExtraction(executionId, now())) return null;
  try {
    const execution = getExecution(executionId);
    if (!execution) {
      settleExtraction(executionId, { status: "skipped", error: "the run is gone" }, now());
      return { status: "skipped", reason: "the run is gone", decisionCount: 0 };
    }
    const steps = readableSteps(getExecutionLineage(executionId)?.steps ?? []);
    if (!steps.length) {
      settleExtraction(executionId, { status: "skipped", error: "no agent answered before the run ended" }, now());
      return { status: "skipped", reason: "no agent answered before the run ended", decisionCount: 0 };
    }

    const scope = memoryScopeFor(execution.teamId);
    const diff = getExecutionDiff(executionId);
    const changedFiles = execution.workspace?.changedFiles?.length ? execution.workspace.changedFiles : pathsInDiff(diff);
    const docs = docsInDiff(diff);
    const task = Object.values(execution.input).filter((v): v is string => typeof v === "string").join(" ");
    const candidates = await hybridSearchFeatures(scope, task, 8);
    const previous = [
      ...searchDecisions(scope, { paths: changedFiles.slice(0, 50), limit: 15 }),
      ...(await hybridSearchDecisions(scope, { query: task, limit: 10 })),
    ]
      .filter((d, i, all) => d.executionId !== executionId && all.findIndex((x) => x.id === d.id) === i)
      .slice(0, 20)
      .map((d) => ({ id: d.id, title: d.title, decision: d.decision, teamId: d.teamId }));
    const implementationsSoFar = candidates
      .map((f) => getImplementation(f.id, execution.teamId))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((impl) => ({ featureId: impl.featureId, summary: impl.summary, pitfalls: impl.pitfalls }));

    const prompt = recorderPrompt({ execution, steps, changedFiles, docs, candidates, previous, implementationsSoFar });
    const result = await provider.execute({
      model: opts.model,
      system: RECORDER_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      maxTokens: MAX_RECORDER_OUTPUT_TOKENS,
      context: { executionId, nodeId: NODE_ID, workflowId: execution.workflowId },
    });
    const usage = {
      model: result.model,
      // Read from the prompt cache or not, it was read: the ledger's input
      // figure is what the recorder was shown, and the cost is exact either way.
      inputTokens: result.usage.inputTokens + result.usage.cacheReadTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: costForUsage(
        tierOf(result.model),
        // `inputTokens` already counts what was written to the cache; the
        // write is priced apart from plain input because it bills at 1.25×
        // (5m) or 2× (1h), and pricing it as input reads too cheap.
        {
          input: result.usage.inputTokens - (result.usage.cacheCreationTokens ?? 0),
          output: result.usage.outputTokens,
          cacheRead: result.usage.cacheReadTokens,
          cacheCreation: result.usage.cacheCreationTokens ?? 0,
        },
        { model: result.model, cacheTtl: loadSettings().promptCache.ttl },
      ),
    };

    // A truncated answer is never valid JSON; say why instead of blaming the
    // model's formatting, which sent the person looking for a fault in their
    // own account. Same reading as the agent executor's.
    if (result.stopReason === "max_tokens") {
      const error = `the recorder hit its output limit (${MAX_RECORDER_OUTPUT_TOKENS} max tokens) and its answer was cut off — raise MAX_RECORDER_OUTPUT_TOKENS, or teach this branch with fewer decisions`;
      settleExtraction(executionId, { status: "failed", error, ...usage }, now());
      return { status: "failed", reason: error, decisionCount: 0 };
    }

    let answer: RecorderAnswer;
    try {
      answer = parseRecorderAnswer(result.text);
    } catch (e) {
      settleExtraction(executionId, { status: "failed", error: (e as Error).message, ...usage }, now());
      return { status: "failed", reason: (e as Error).message, decisionCount: 0 };
    }

    // The feature first, so the decisions can point at it.
    let featureId: string | null = null;
    if (answer.feature) {
      const matched = answer.feature.match ? candidates.find((c) => c.id === answer.feature!.match) : null;
      // The catalogue line: the model's description, or failing that the
      // first sentence of the implementation summary — never left blank.
      const description = answer.feature.description.trim() || answer.feature.summary.trim().split(/(?<=[.!?])\s/)[0] || "";
      if (matched) {
        featureId = upsertFeature({
          id: matched.id,
          orgId: scope.orgId,
          name: matched.name,
          aliases: answer.feature.aliases,
          summary: matched.summary || description,
          now: now(),
        }).id;
      } else if (answer.feature.name.trim()) {
        featureId = upsertFeature({ orgId: scope.orgId, name: answer.feature.name, aliases: answer.feature.aliases, summary: description, now: now() }).id;
      }
    }

    const validFrom = execution.finishedAt ?? now();
    const decisions = replaceDecisions(
      {
        executionId,
        teamId: execution.teamId,
        userId: execution.userId,
        featureId,
        // Whatever repository the run named itself; never inferred from the
        // team, which may own several.
        repoId: execution.repoId,
        baseCommit: execution.workspace?.baseCommit ?? null,
        headCommit: execution.workspace?.commit ?? null,
        outcome: outcomeOf(execution, steps),
        validFrom,
      },
      answer.decisions,
      now(),
    );
    if (featureId && answer.feature) {
      upsertImplementation({
        featureId,
        teamId: execution.teamId,
        summary: answer.feature.summary,
        pitfalls: answer.feature.pitfalls,
        now: now(),
      });
    }
    settleExtraction(executionId, { status: "done", decisionCount: decisions.length, ...usage }, now());
    return { status: "done", decisionCount: decisions.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    settleExtraction(executionId, { status: "failed", error: message }, now());
    return { status: "failed", reason: message, decisionCount: 0 };
  }
}

export type { Extraction };
