import { z } from "zod";

/** Request-body schemas for the management API. Invalid input → 400. */

const tier = z.enum(["haiku", "sonnet", "opus", "fable"]);
// "none" accepted for pre-v2 clients; normalized to "default" on load.
const effort = z.enum(["default", "none", "low", "medium", "high", "xhigh", "max"]);

/** Object keyed by tier with every key optional (a partial Record<Tier, V>). */
const perTier = <T extends z.ZodTypeAny>(v: T) =>
  z.object({ haiku: v, sonnet: v, opus: v, fable: v }).partial();

/** Object keyed by routing category with every key optional. */
const perCategory = <T extends z.ZodTypeAny>(v: T) =>
  z
    .object({ background: v, trivial: v, agentic: v, largeContext: v, heavy: v, default: v })
    .partial();

export const settingsPatchSchema = z
  .object({
    compression: z
      .object({
        enabled: z.boolean(),
        maxBlockChars: z.number().int().min(500).max(1_000_000),
        dedupe: z.boolean(),
      })
      .partial(),
    cache: z
      .object({
        enabled: z.boolean(),
        ttlSeconds: z.number().int().min(1).max(60 * 60 * 24 * 30),
      })
      .partial(),
    budget: z
      .object({
        enabled: z.boolean(),
        mode: z.enum(["warn", "block"]),
        dailyUsd: z.number().min(0),
        monthlyUsd: z.number().min(0),
      })
      .partial(),
    fallback: z
      .object({
        enabled: z.boolean(),
        chains: perTier(z.array(tier)),
      })
      .partial(),
    reasoning: z.object({ defaultEffort: effort }).partial(),
    promptCache: z.object({ enabled: z.boolean(), ttl: z.enum(["5m", "1h"]) }).partial(),
    concurrency: z
      .object({
        maxInFlight: z.number().int().min(1).max(64),
        queueTimeoutMs: z.number().int().min(1000).max(600_000),
      })
      .partial(),
    throttle: z
      .object({
        enabled: z.boolean(),
        downgradeAt: z.number().min(0).max(1),
        blockAt: z.number().min(0).max(1),
      })
      .partial(),
    retry: z
      .object({
        maxRetries: z.number().int().min(0).max(5),
        maxRateLimitWaitMs: z.number().int().min(0).max(60_000),
      })
      .partial(),
    routingPrecision: z.object({ countTokens: z.boolean() }).partial(),
  })
  .partial()
  .strict();

export const routingPatchSchema = z
  .object({
    tiers: perTier(z.string().min(1).max(100)),
    aliases: z.record(z.string().min(1).max(100), z.string().min(1).max(100)),
    thresholds: z
      .object({
        largeContext: z.number().int().min(1),
        trivial: z.number().int().min(0),
        haikuContextMax: z.number().int().min(1000).max(200_000),
      })
      .partial(),
    heavyKeywords: z.array(z.string().min(1).max(200)).max(200),
    backgroundKeywords: z.array(z.string().min(1).max(200)).max(200),
    default: tier,
    categories: perCategory(tier),
    effort: perCategory(effort),
    preset: z.enum(["economy", "balanced", "quality"]),
    classifier: z.object({ enabled: z.boolean(), minTokens: z.number().int().min(0).max(100_000) }).partial(),
    sticky: z.object({ enabled: z.boolean(), minTokens: z.number().int().min(0).max(1_000_000) }).partial(),
    overrideExplicit: z.boolean(),
  })
  .partial()
  .strict();

export const createKeySchema = z.object({ name: z.string().min(1).max(64) });

export const adminLoginSchema = z.object({ secret: z.string().min(1).max(512) });

export const clientApplySchema = z.object({
  client: z.enum(["claude-code"]),
  action: z.enum(["apply", "revert"]),
  apiKey: z.string().max(200).optional(),
});
