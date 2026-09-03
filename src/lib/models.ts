import { ANTHROPIC_API_BASE, CLAUDE_CODE_VERSION } from "./claude/config";
import { getValidCredentials } from "./token-manager";

/**
 * Available model catalogue. Fetched live from Anthropic's /v1/models on the
 * user's OAuth token so the dashboard lists what the account can actually use;
 * falls back to a known list if the fetch fails.
 */

export const KNOWN_MODELS = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
];

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { ids: string[]; at: number; source: "live" | "fallback" } | null = null;

export async function fetchAvailableModels(): Promise<{ models: string[]; source: "live" | "fallback" }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { models: cache.ids, source: cache.source };
  }

  const creds = await getValidCredentials();
  if (creds) {
    try {
      const res = await fetch(`${ANTHROPIC_API_BASE}/v1/models?limit=100`, {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        const ids = (data.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string" && id.startsWith("claude-"));
        if (ids.length > 0) {
          // Newest-looking first: fable > opus > sonnet > haiku, then by id desc.
          const rank = (id: string) =>
            id.includes("fable") ? 0 : id.includes("opus") ? 1 : id.includes("sonnet") ? 2 : 3;
          ids.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
          cache = { ids, at: Date.now(), source: "live" };
          return { models: ids, source: "live" };
        }
      }
    } catch {
      // fall through to fallback
    }
  }

  cache = { ids: KNOWN_MODELS, at: Date.now(), source: "fallback" };
  return { models: KNOWN_MODELS, source: "fallback" };
}
