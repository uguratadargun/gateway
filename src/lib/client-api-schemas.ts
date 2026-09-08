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
  })
  .partial();

export const startRunSchema = z
  .object({
    workflowId: z.string().min(1).max(64),
    input: z.record(z.string(), z.unknown()).default({}),
    client: clientInfo.default({}),
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

export const reportSchema = z
  .object({
    events: z.array(eventSchema).max(500).default([]),
    steps: z.array(stepSchema).max(100).default([]),
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
        commit: z.string().max(80).nullable().default(null),
        changedFiles: z.array(z.string().max(500)).max(200).default([]),
      })
      .nullish(),
    /** The unified diff the run left in its worktree; already capped client-side. */
    diff: z.string().max(4_000_000).nullish(),
  })
  .strict();
