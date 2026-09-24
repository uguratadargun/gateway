import { z } from "zod";

import { PROVIDER_KINDS } from "./providers";

/** Request-body schemas for the management API. Invalid input → 400. */

export const settingsPatchSchema = z
  .object({
    plugin: z.object({ source: z.string().max(300) }).partial(),
    memory: z
      .object({
        enabled: z.boolean(),
        // Only a provider can be served here; empty switches the recorder off
        // until one is named.
        model: z
          .string()
          .max(160)
          .refine((m) => m.trim() === "" || /^(provider|local):[^/]+\/.+/.test(m.trim()), "the recorder runs on a provider model: provider:<name>/<model>"),
        embeddings: z.object({ provider: z.string().max(100), model: z.string().max(100) }).partial(),
        consolidateEvery: z.number().int().min(0).max(1000),
        indexEveryMinutes: z.number().int().min(0).max(1440),
        recordMerges: z.boolean(),
      })
      .partial(),
  })
  .partial()
  .strict();

export const createKeySchema = z.object({
  name: z.string().min(1).max(64),
  /** The person this key is for. Omitted keeps the pre-multi-user behaviour. */
  userId: z.string().min(1).max(64).optional(),
  teamId: z.string().min(1).max(64).optional(),
  scopes: z.array(z.enum(["workflows", "author"])).min(1).optional(),
});

export const createTeamSchema = z.object({
  name: z.string().min(1).max(80),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits and dashes")
    .optional(),
  /** The team this one sits under, for android and desktop under ulak. */
  parentId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits and dashes")
    .nullish(),
});

export const updateTeamSchema = z
  .object({
    parentId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits and dashes")
      .nullable(),
  })
  .strict();

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

const baseUrl = z
  .string()
  .min(1)
  .max(400)
  .refine((v) => /^https?:\/\//i.test(v.trim()), "Base URL must start with http:// or https://");

/** Which wire dialect the endpoint speaks; see `lib/providers.ts`. */
const providerKind = z.enum(PROVIDER_KINDS);
/** Models named by hand, as a list or as one comma/newline-separated string. */
const providerModels = z.union([z.array(z.string().max(120)).max(100), z.string().max(4000)]);

export const createProviderSchema = z.object({
  name: z.string().min(1).max(40),
  label: z.string().min(1).max(80).optional(),
  kind: providerKind.optional(),
  baseUrl,
  apiKey: z.string().max(400).optional(),
  enabled: z.boolean().optional(),
  models: providerModels.optional(),
});

export const updateProviderSchema = z
  .object({
    name: z.string().min(1).max(40),
    label: z.string().min(1).max(80),
    kind: providerKind,
    baseUrl,
    /** An empty string clears the stored key. */
    apiKey: z.string().max(400),
    enabled: z.boolean(),
    /** An empty list goes back to discovering the catalogue. */
    models: providerModels,
  })
  .partial()
  .strict();
