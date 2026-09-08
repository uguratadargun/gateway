import { randomUUID } from "node:crypto";

import { getDb } from "./db";
import { ANTHROPIC_VERSION } from "./claude/config";
import { seal, tryOpen } from "./seal";

/**
 * Non-Anthropic endpoints gate can route to. Two dialects:
 *
 * - `openai-compat` — anything speaking POST {baseUrl}/chat/completions:
 *   Ollama, vLLM, LM Studio, llama.cpp, or a hosted endpoint. gate translates
 *   Anthropic ↔ OpenAI in both directions (`anthropic-openai.ts`).
 * - `anthropic-compat` — an endpoint that already speaks
 *   POST {baseUrl}/v1/messages, so gate forwards the request as it stands.
 *   Z.AI's `https://api.z.ai/api/anthropic` is the one people reach for; it is
 *   also the dialect a spawned Claude Code wants, because nothing it sends —
 *   tool blocks, cache breakpoints, streamed thinking — has to survive a
 *   round trip through a second wire format first.
 *
 * Either way a provider's models are addressed as `local:<name>/<model>`
 * wherever gate takes a model id. The prefix is historical: it means "not one
 * of the connected Claude accounts", not "on this machine" — `selfHosted`
 * below is what actually says whether the traffic leaves the network.
 */

export const PROVIDER_KINDS = ["openai-compat", "anthropic-compat"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function normalizeKind(kind: unknown): ProviderKind {
  return kind === "anthropic-compat" ? "anthropic-compat" : "openai-compat";
}

export interface Provider {
  id: string;
  /** Slug used in model references. */
  name: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  /** True when a key is stored; the key itself never leaves this module. */
  hasApiKey: boolean;
  enabled: boolean;
  /** Loopback / RFC1918 / .local endpoints — the traffic never leaves the network. */
  selfHosted: boolean;
  /**
   * Models the user named by hand. Set, it *is* the catalogue and nothing is
   * probed — an endpoint that serves no `/models` list (Z.AI's Anthropic one
   * among them) would otherwise read as unreachable and leave every picker
   * empty.
   */
  models: string[];
  createdAt: number;
  updatedAt: number;
}

const PRIVATE_V4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * Is this base URL an endpoint on our own network? Loopback, RFC1918 /
 * link-local addresses, a bare container-DNS hostname, and the .local /
 * .internal / .lan suffixes. Anything routable on the public internet — a
 * private VPC hostname that resolves publicly included — is not claimed here.
 *
 * Ported from ulak-gateway's src/ulak/selfHosted.ts.
 */
export function isSelfHostedBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
  let host: string;
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare === "::1" || bare === "0.0.0.0") return true;
  if (PRIVATE_V4.test(bare)) return true;
  if (bare.startsWith("fc") || bare.startsWith("fd")) return true; // IPv6 unique-local
  if (!bare.includes(".")) return true; // docker / k8s service name
  return /\.(local|internal|lan)$/.test(bare);
}

/** Trailing slashes off, so `${baseUrl}/chat/completions` is never doubled. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** A provider name is a slug: it appears inside `local:<name>/<model>`. */
export function normalizeProviderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** The declared catalogue as stored: a JSON array, or null for "discover it". */
function parseModels(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string" && !!m.trim()) : [];
  } catch {
    return [];
  }
}

/** Free-text or an array from the client, as the trimmed list we store. */
export function normalizeModelList(models: unknown): string[] {
  const raw = typeof models === "string" ? models.split(/[\n,]/) : Array.isArray(models) ? models : [];
  const seen = new Set<string>();
  for (const m of raw) {
    if (typeof m !== "string") continue;
    const t = m.trim();
    if (t) seen.add(t);
  }
  return [...seen].slice(0, 100);
}

function mapProvider(row: Record<string, unknown>): Provider {
  const baseUrl = String(row.base_url);
  return {
    id: String(row.id),
    name: String(row.name),
    label: String(row.label),
    kind: normalizeKind(row.kind),
    baseUrl,
    hasApiKey: !!row.api_key_sealed,
    enabled: Number(row.enabled) === 1,
    selfHosted: isSelfHostedBaseUrl(baseUrl),
    models: parseModels(row.models_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function listProviders(): Provider[] {
  return (
    getDb().prepare("SELECT * FROM providers ORDER BY created_at ASC").all() as Array<Record<string, unknown>>
  ).map(mapProvider);
}

export function getProvider(id: string): Provider | null {
  const row = getDb().prepare("SELECT * FROM providers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapProvider(row) : null;
}

export function getProviderByName(name: string): Provider | null {
  const row = getDb().prepare("SELECT * FROM providers WHERE name = ?").get(name) as
    | Record<string, unknown>
    | undefined;
  return row ? mapProvider(row) : null;
}

/** The stored API key, decrypted. Null when the endpoint needs no auth. */
export function providerApiKey(id: string): string | null {
  const row = getDb().prepare("SELECT api_key_sealed FROM providers WHERE id = ?").get(id) as
    | { api_key_sealed: string | null }
    | undefined;
  return tryOpen(row?.api_key_sealed);
}

export function createProvider(input: {
  name: string;
  label?: string;
  kind?: ProviderKind;
  baseUrl: string;
  apiKey?: string | null;
  enabled?: boolean;
  models?: string[] | string;
}): Provider {
  const now = Date.now();
  const id = randomUUID();
  const name = normalizeProviderName(input.name);
  if (!name) throw new Error("Provider name must contain a letter or digit");
  const models = normalizeModelList(input.models);
  getDb()
    .prepare(
      `INSERT INTO providers (id, name, label, kind, base_url, api_key_sealed, enabled, models_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      input.label?.trim() || name,
      normalizeKind(input.kind),
      normalizeBaseUrl(input.baseUrl),
      input.apiKey ? seal(input.apiKey) : null,
      input.enabled === false ? 0 : 1,
      models.length ? JSON.stringify(models) : null,
      now,
      now,
    );
  return getProvider(id)!;
}

export function updateProvider(
  id: string,
  patch: {
    name?: string;
    label?: string;
    kind?: ProviderKind;
    baseUrl?: string;
    apiKey?: string | null;
    enabled?: boolean;
    models?: string[] | string;
  },
): Provider | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    const name = normalizeProviderName(patch.name);
    if (!name) throw new Error("Provider name must contain a letter or digit");
    sets.push("name = ?");
    params.push(name);
  }
  if (patch.label !== undefined) {
    sets.push("label = ?");
    params.push(patch.label.trim());
  }
  if (patch.kind !== undefined) {
    sets.push("kind = ?");
    params.push(normalizeKind(patch.kind));
  }
  // An empty list goes back to discovery; undefined leaves it alone.
  if (patch.models !== undefined) {
    const models = normalizeModelList(patch.models);
    sets.push("models_json = ?");
    params.push(models.length ? JSON.stringify(models) : null);
  }
  if (patch.baseUrl !== undefined) {
    sets.push("base_url = ?");
    params.push(normalizeBaseUrl(patch.baseUrl));
  }
  // An empty string clears the key; undefined leaves it alone.
  if (patch.apiKey !== undefined) {
    sets.push("api_key_sealed = ?");
    params.push(patch.apiKey ? seal(patch.apiKey) : null);
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return getProvider(id);
  sets.push("updated_at = ?");
  params.push(Date.now(), id);
  getDb().prepare(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getProvider(id);
}

export function deleteProvider(id: string): boolean {
  return Number(getDb().prepare("DELETE FROM providers WHERE id = ?").run(id).changes) > 0;
}

// ── model reference: provider:<provider>/<model> ────────────────────────────

export interface ProviderModelRef {
  provider: string;
  model: string;
}

/** The prefix gate writes today, and the one it used to write. */
const REF_PREFIX = "provider:";
const LEGACY_REF_PREFIX = "local:";

/**
 * Parse `provider:<name>/<model>`. The model half may itself contain slashes
 * (`provider:ollama/library/qwen3:8b`), so only the first one separates them.
 *
 * `local:` is still accepted, and always will be: it was the original prefix,
 * and a routing.json or an agent definition written back then must keep
 * resolving. It was renamed because it was never about locality — a hosted
 * endpoint like Z.AI is as much a provider as an Ollama on the desk, and
 * calling that "local" reads as a lie in every picker.
 */
export function parseProviderRef(ref: unknown): ProviderModelRef | null {
  if (typeof ref !== "string") return null;
  const rest = ref.trim();
  const lower = rest.toLowerCase();
  const prefix = lower.startsWith(REF_PREFIX)
    ? REF_PREFIX
    : lower.startsWith(LEGACY_REF_PREFIX)
      ? LEGACY_REF_PREFIX
      : null;
  if (!prefix) return null;
  const body = rest.slice(prefix.length);
  const slash = body.indexOf("/");
  if (slash <= 0 || slash === body.length - 1) return null;
  return { provider: body.slice(0, slash), model: body.slice(slash + 1) };
}

export function formatProviderRef(provider: string, model: string): string {
  return `${REF_PREFIX}${provider}/${model}`;
}

/**
 * A model id in the form gate compares and stores. Only provider refs change:
 * a legacy `local:` one becomes its `provider:` equivalent, so a tier still
 * written the old way in routing.json matches a picker that now writes the new
 * way. A Claude model id is returned untouched.
 */
export function canonicalModelRef(model: string): string {
  const ref = parseProviderRef(model);
  return ref ? formatProviderRef(ref.provider, ref.model) : model;
}

// ── live model discovery ────────────────────────────────────────────────────

const MODELS_TTL_MS = 60_000;
const MODELS_TIMEOUT_MS = 10_000;
const modelCache = new Map<string, { at: number; models: string[]; error: string | null }>();

/**
 * The catalogue endpoint and the auth header each dialect uses. Both answer
 * `{ data: [{ id }] }`, so only the address and the header differ.
 */
export function catalogueRequest(provider: Provider, apiKey: string | null): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider.kind === "anthropic-compat") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    return { url: `${provider.baseUrl}/v1/models`, headers };
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { url: `${provider.baseUrl}/models`, headers };
}

/**
 * What models a provider serves: the list the user declared, or — when they
 * declared none — whatever its catalogue endpoint reports. Cached briefly so a
 * dashboard with several pickers open does not hammer a small local box. A
 * failure is reported, not thrown; the panel shows it as unreachable and the
 * user can name the models by hand instead.
 */
export async function listProviderModels(
  provider: Provider,
  options: { force?: boolean } = {},
): Promise<{ models: string[]; error: string | null }> {
  // Declared beats discovered: there is nothing to ask an endpoint whose
  // catalogue the user has already written down, and several — Z.AI's
  // Anthropic endpoint among them — serve no catalogue at all.
  if (provider.models.length > 0) return { models: [...provider.models], error: null };

  const hit = modelCache.get(provider.id);
  if (!options.force && hit && Date.now() - hit.at < MODELS_TTL_MS && !hit.error) {
    return { models: hit.models, error: null };
  }

  let result: { models: string[]; error: string | null };
  try {
    const { url, headers } = catalogueRequest(provider, providerApiKey(provider.id));
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = (Array.isArray(payload.data) ? payload.data : [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort((a, b) => a.localeCompare(b));
    result = { models, error: null };
  } catch (error) {
    result = { models: [], error: error instanceof Error ? error.message : String(error) };
  }
  modelCache.set(provider.id, { at: Date.now(), ...result });
  return result;
}

/** Drop a provider's cached catalogue (after an edit, or an explicit refresh). */
export function forgetProviderModels(id: string): void {
  modelCache.delete(id);
}
