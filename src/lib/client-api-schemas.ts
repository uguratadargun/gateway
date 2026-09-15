import { z } from "zod";

/**
 * Bodies the client API accepts.
 *
 * These arrive from a CLI on someone else's machine, so they are validated the
 * way the management endpoints are — except that what a run reports about
 * itself is largely opaque (a node's input and output are whatever the workflow
 * said). The rule is: everything the server *indexes* is checked, everything it
 * only stores and hands back is bounded but not typed.
 */

const clientInfo = z
  .object({
    host: z.string().max(120).optional(),
    repo: z.string().max(500).optional(),
    branch: z.string().max(200).optional(),
    version: z.string().max(40).optional(),
    /**
     * The Claude Code session driving the run, when the plugin's hook could
     * learn it. The gateway files that session's own model calls under the
     * same id, which is what lets the nodes the session does itself be
     * costed against the run.
     */
    session: z.string().max(80).optional(),
  })
  .partial();

export const startRunSchema = z
  .object({
    workflowId: z.string().min(1).max(64),
    input: z.record(z.string(), z.unknown()).default({}),
    client: clientInfo.default({}),
    /** "session" when a Claude Code session walks the graph a node at a time. */
    driver: z.enum(["engine", "session"]).default("engine"),
  })
  .strict();

const usageSchema = z.object({
  model: z.string().max(120),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
});

const toolCallSchema = z.object({
  tool: z.string().max(80),
  input: z.unknown(),
  ok: z.boolean(),
  result: z.string(),
  startedAt: z.number(),
  durationMs: z.number(),
});

/**
 * The cross-team objection protocol, version 1.
 *
 * A node's output is otherwise whatever its workflow said it was, and
 * `buildOutputSchema` deliberately passes extra keys through — models add
 * commentary fields all the time. These two keys are the exception: they are
 * the only part of an output that changes anything outside its own run, so
 * they get a fixed shape the server owns, not one a team's agent definition
 * can widen.
 *
 * They are read out of the step's output rather than added to `stepSchema`,
 * and a malformed one is skipped instead of failing the report. The reason is
 * `RunReporter`: it re-queues a rejected batch whole and gives up after four
 * tries, so a single model that answered `conflicts: "none"` would cost the
 * run every step it had left to send.
 */
export const CONFLICT_PROTOCOL_VERSION = 1;

export const conflictSchema = z
  .object({
    /** Unique within the step. The approval names this, so it needs no server round-trip. */
    conflictKey: z.string().min(1).max(120),
    /** Whose decision is being disagreed with. Checked against the caller's family. */
    targetTeamId: z.string().min(1).max(64),
    decisionId: z.string().max(100).nullish(),
    featureId: z.string().max(100).nullish(),
    paths: z.array(z.string().max(500)).max(50).default([]),
    title: z.string().min(1).max(200),
    /** What the other team decided, copied here so the objection survives a re-extraction. */
    decisionSnapshot: z.string().max(4000).default(""),
    rationale: z.string().max(4000).default(""),
    proposal: z.string().max(4000).default(""),
    revision: z.string().max(4000).default(""),
  })
  .strict();

export const resolvedSchema = z
  .object({
    sourceNodeId: z.string().min(1).max(64),
    sourceVisit: z.number().int().min(0),
    conflictKey: z.string().min(1).max(120),
    decision: z.enum(["confirm", "reject"]),
    note: z.string().max(4000).default(""),
  })
  .strict();

export const conflictsFieldSchema = z.array(conflictSchema).max(20);
export const resolvedFieldSchema = z.array(resolvedSchema).max(20);

export type ReportedConflict = z.infer<typeof conflictSchema>;
export type ReportedResolution = z.infer<typeof resolvedSchema>;

export const stepSchema = z.object({
  nodeId: z.string().min(1).max(64),
  stepIndex: z.number().int().min(0),
  visit: z.number().int().min(0),
  status: z.enum(["completed", "failed"]),
  startedAt: z.number(),
  finishedAt: z.number(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.object({ code: z.string().max(64), message: z.string().max(4000) }).optional(),
  usage: usageSchema.optional(),
  /** The session did this node itself: cost it from the session's own gateway calls. */
  costing: z.literal("session").optional(),
  toolCalls: z.array(toolCallSchema).optional(),
});

/**
 * An event is replayed to the dashboard and never stored, so it is checked for
 * shape only. `executionId` is ignored if present: the URL decides which run an
 * event belongs to, so no client can push events onto another run.
 */
export const eventSchema = z
  .object({
    type: z.string().min(1).max(40),
    at: z.number(),
  })
  .passthrough();

const workspaceSchema = z.object({
  root: z.string().max(1000),
  repo: z.string().max(1000),
  branch: z.string().max(200),
  baseRef: z.string().max(200),
  baseCommit: z.string().max(80).optional(),
});

export const reportSchema = z
  .object({
    events: z.array(eventSchema).max(500).default([]),
    steps: z.array(stepSchema).max(100).default([]),
    /**
     * The run's worktree, sent once when it is created. A run driven from a
     * session reads it back on every step, and the dashboard shows the branch
     * while the run is going rather than only after it ends.
     */
    workspace: workspaceSchema.nullish(),
  })
  .strict();

export const finishRunSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    error: z.object({ code: z.string().max(64), message: z.string().max(4000) }).nullish(),
    stepCount: z.number().int().min(0).default(0),
    workspace: z
      .object({
        root: z.string().max(1000),
        repo: z.string().max(1000),
        branch: z.string().max(200),
        baseRef: z.string().max(200),
        baseCommit: z.string().max(80).optional(),
        commit: z.string().max(80).nullable().default(null),
        changedFiles: z.array(z.string().max(500)).max(200).default([]),
      })
      .nullish(),
    /** The unified diff the run left in its worktree; already capped client-side. */
    diff: z.string().max(4_000_000).nullish(),
  })
  .strict();

/**
 * What an engineer's session read out of a finished branch — the stand-in for
 * the answers a run's agents would have given. Strict, because a field the
 * session named differently would otherwise vanish without a word, and the
 * recorder can only write what it is shown.
 */
export const teachAccountSchema = z
  .object({
    /** What the work was for, as the person who asked for it would put it. */
    task: z.string().trim().min(1).max(4000),
    /** The approach as it was carried out, step by step. */
    plan: z.string().max(8000).default(""),
    /** Each real choice: what was chosen, why, and what was not taken. */
    decisions: z.string().max(12000).default(""),
    /** How it works now: flows, components, states, edge cases. Logic, not code. */
    implementation: z.string().max(12000).default(""),
    verification: z.string().max(4000).default(""),
    pitfalls: z.string().max(4000).default(""),
    /** Where the account comes from: the commits, a merge request, the person's own answers. */
    evidence: z.string().max(2000).default(""),
  })
  .strict();

export const teachCommitSchema = z.object({
  sha: z.string().min(4).max(80),
  date: z.string().max(40),
  author: z.string().max(200).default(""),
  subject: z.string().max(1000),
  body: z.string().max(4000).default(""),
});

/** `POST /api/v1/memory/teach`: a finished branch, to be recorded as a run would be. */
export const teachSchema = z
  .object({
    account: teachAccountSchema,
    commits: z.array(teachCommitSchema).max(500).default([]),
    workspace: z.object({
      root: z.string().max(1000),
      repo: z.string().max(1000),
      branch: z.string().min(1).max(200),
      baseRef: z.string().max(200),
      baseCommit: z.string().min(4).max(80),
      commit: z.string().min(4).max(80),
      changedFiles: z.array(z.string().max(500)).max(200).default([]),
    }),
    /** The branch's first commit and its last: when the work began and when it started holding. */
    startedAt: z.number().int().min(0),
    finishedAt: z.number().int().min(0),
    diff: z.string().max(4_000_000).nullish(),
    host: z.string().max(120).nullish(),
    version: z.string().max(40).nullish(),
    /** Teach it even though a run already recorded this branch. */
    force: z.boolean().default(false),
  })
  .strict();

export type TeachAccount = z.infer<typeof teachAccountSchema>;
export type TeachCommit = z.infer<typeof teachCommitSchema>;
export type TeachRequest = z.input<typeof teachSchema>;

/** Query-string parameters of `GET /api/v1/memory/search`, as strings. */
const epochMs = z
  .string()
  .transform((v) => (/^\d+$/.test(v) ? Number(v) : Date.parse(v)))
  .refine((n) => Number.isFinite(n), "not a time")
  .optional();

export const memorySearchSchema = z
  .object({
    query: z.string().max(2000).optional(),
    paths: z.array(z.string().max(500)).max(50).default([]),
    featureId: z.string().max(100).optional(),
    asOf: epochMs,
    since: epochMs,
    limit: z
      .string()
      .transform((v) => Number(v))
      .refine((n) => Number.isInteger(n) && n > 0, "not a count")
      .optional(),
  })
  .refine((v) => v.query || v.paths.length || v.featureId, { message: "give q, path, or feature" });
