import { z } from "zod";

/** Request-body schemas for the management API. Invalid input → 400. */

const tier = z.enum(["haiku", "sonnet", "opus", "fable"]);

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
    reasoning: z.object({ defaultEffort: z.enum(["none", "low", "medium", "high"]) }).partial(),
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
      })
      .partial(),
    heavyKeywords: z.array(z.string().min(1).max(200)).max(200),
    backgroundKeywords: z.array(z.string().min(1).max(200)).max(200),
    default: tier,
    categories: perCategory(tier),
    overrideExplicit: z.boolean(),
  })
  .partial()
  .strict();

export const createKeySchema = z.object({ name: z.string().min(1).max(64) });

export const adminLoginSchema = z.object({ secret: z.string().min(1).max(512) });
