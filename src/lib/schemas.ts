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
    accountPool: z
      .object({
        strategy: z.enum(["fill-first", "round-robin", "least-used", "p2c", "random"]),
        stickyRoundRobinLimit: z.number().int().min(1).max(1000),
        quotaMinRemainingPercent: z.number().int().min(0).max(99),
        quotaRefreshMinutes: z.number().int().min(10).max(1440),
      })
      .partial(),
  })
  .partial()
  .strict();

export const routingPatchSchema = z
  .object({
    tiers: perTier(z.string().min(1).max(200)),
    aliases: z.record(z.string().min(1).max(100), z.string().min(1).max(200)),
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

export const createKeySchema = z.object({
  name: z.string().min(1).max(64),
  /** The person this key is for. Omitted keeps the pre-multi-user behaviour. */
  userId: z.string().min(1).max(64).optional(),
  teamId: z.string().min(1).max(64).optional(),
  scopes: z.array(z.enum(["gateway", "workflows", "author"])).min(1).optional(),
});

export const createTeamSchema = z.object({
  name: z.string().min(1).max(80),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits and dashes")
    .optional(),
});

export const createUserSchema = z.object({
  email: z.string().email().max(160),
  name: z.string().min(1).max(80).optional(),
  teamId: z.string().min(1).max(64),
});

export const updateUserSchema = z
  .object({
    name: z.string().max(80),
    teamId: z.string().min(1).max(64),
    disabled: z.boolean(),
  })
  .partial();

export const adminLoginSchema = z.object({ secret: z.string().min(1).max(512) });

export const clientApplySchema = z.object({
  client: z.enum(["claude-code"]),
  action: z.enum(["apply", "revert"]),
  apiKey: z.string().max(200).optional(),
});

export const createAccountSchema = z.object({
  code: z.string().min(1).max(2000),
  label: z.string().min(1).max(80).optional(),
});

export const updateAccountSchema = z
  .object({
    label: z.string().min(1).max(80),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(9999),
  })
  .partial()
  .strict();

const baseUrl = z
  .string()
  .min(1)
  .max(400)
  .refine((v) => /^https?:\/\//i.test(v.trim()), "Base URL must start with http:// or https://");

export const createProviderSchema = z.object({
  name: z.string().min(1).max(40),
  label: z.string().min(1).max(80).optional(),
  baseUrl,
  apiKey: z.string().max(400).optional(),
  enabled: z.boolean().optional(),
});

export const updateProviderSchema = z
  .object({
    name: z.string().min(1).max(40),
    label: z.string().min(1).max(80),
    baseUrl,
    /** An empty string clears the stored key. */
    apiKey: z.string().max(400),
    enabled: z.boolean(),
  })
  .partial()
  .strict();
