import { randomUUID } from "node:crypto";

import { getDb } from "./db";
import { seal, tryOpen } from "./seal";

/**
 * Self-hosted / OpenAI-compatible endpoints gate can route to: Ollama, vLLM,
 * LM Studio, llama.cpp, or any cloud endpoint that speaks
 * POST {baseUrl}/chat/completions. A provider's models are addressed as
 * `local:<name>/<model>` wherever gate takes a model id.
 */

export interface LocalProvider {
  id: string;
  /** Slug used in model references. */
  name: string;
  label: string;
  kind: "openai-compat";
  baseUrl: string;
  /** True when a key is stored; the key itself never leaves this module. */
  hasApiKey: boolean;
  enabled: boolean;
  /** Loopback / RFC1918 / .local endpoints — the traffic never leaves the network. */
  selfHosted: boolean;
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

function mapProvider(row: Record<string, unknown>): LocalProvider {
  const baseUrl = String(row.base_url);
  return {
    id: String(row.id),
    name: String(row.name),
    label: String(row.label),
    kind: "openai-compat",
    baseUrl,
    hasApiKey: !!row.api_key_sealed,
    enabled: Number(row.enabled) === 1,
    selfHosted: isSelfHostedBaseUrl(baseUrl),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function listProviders(): LocalProvider[] {
  return (
    getDb().prepare("SELECT * FROM providers ORDER BY created_at ASC").all() as Array<Record<string, unknown>>
  ).map(mapProvider);
}

export function getProvider(id: string): LocalProvider | null {
  const row = getDb().prepare("SELECT * FROM providers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapProvider(row) : null;
}

export function getProviderByName(name: string): LocalProvider | null {
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
  baseUrl: string;
  apiKey?: string | null;
  enabled?: boolean;
}): LocalProvider {
  const now = Date.now();
  const id = randomUUID();
  const name = normalizeProviderName(input.name);
  if (!name) throw new Error("Provider name must contain a letter or digit");
  getDb()
    .prepare(
      `INSERT INTO providers (id, name, label, kind, base_url, api_key_sealed, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'openai-compat', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      input.label?.trim() || name,
      normalizeBaseUrl(input.baseUrl),
      input.apiKey ? seal(input.apiKey) : null,
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
  return getProvider(id)!;
}

export function updateProvider(
  id: string,
  patch: { name?: string; label?: string; baseUrl?: string; apiKey?: string | null; enabled?: boolean },
): LocalProvider | null {
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

// ── model reference: local:<provider>/<model> ───────────────────────────────

export interface LocalModelRef {
  provider: string;
  model: string;
}

/**
 * Parse `local:<provider>/<model>`. The model half may itself contain slashes
 * (`local:ollama/library/qwen3:8b`), so only the first one separates them.
 */
export function parseLocalRef(ref: unknown): LocalModelRef | null {
  if (typeof ref !== "string") return null;
  const rest = ref.trim();
  if (!rest.toLowerCase().startsWith("local:")) return null;
  const body = rest.slice("local:".length);
  const slash = body.indexOf("/");
  if (slash <= 0 || slash === body.length - 1) return null;
  return { provider: body.slice(0, slash), model: body.slice(slash + 1) };
}

export function formatLocalRef(provider: string, model: string): string {
  return `local:${provider}/${model}`;
}

// ── live model discovery ────────────────────────────────────────────────────

const MODELS_TTL_MS = 60_000;
const MODELS_TIMEOUT_MS = 10_000;
const modelCache = new Map<string, { at: number; models: string[]; error: string | null }>();

/**
 * GET {baseUrl}/models on a provider. Cached briefly so a dashboard with
 * several pickers open does not hammer a small local box. A failure is
 * reported, not thrown — the panel falls back to free-text entry.
 */
export async function listProviderModels(
  provider: LocalProvider,
  options: { force?: boolean } = {},
): Promise<{ models: string[]; error: string | null }> {
  const hit = modelCache.get(provider.id);
  if (!options.force && hit && Date.now() - hit.at < MODELS_TTL_MS && !hit.error) {
    return { models: hit.models, error: null };
  }

  let result: { models: string[]; error: string | null };
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const key = providerApiKey(provider.id);
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${provider.baseUrl}/models`, {
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
