import { ANTHROPIC_API_BASE } from "./claude/config";
import { applyClaudeCodeIdentity } from "./claude/identity";
import { getValidCredentials } from "./token-manager";

const COUNT_URL = `${ANTHROPIC_API_BASE}/v1/messages/count_tokens`;

/**
 * Exact prompt token count from Anthropic's count_tokens endpoint. Returns null
 * on any failure so callers fall back to the local estimate.
 */
export async function countTokens(
  body: Record<string, unknown>,
  model: string,
): Promise<number | null> {
  const creds = await getValidCredentials();
  if (!creds) return null;
  const payload: Record<string, unknown> = { model };
  if (body.system != null) payload.system = body.system;
  if (Array.isArray(body.messages)) payload.messages = body.messages;
  if (Array.isArray(body.tools)) payload.tools = body.tools;
  if (body.thinking) payload.thinking = body.thinking;
  if (body.tool_choice) payload.tool_choice = body.tool_choice;
  try {
    const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const headers = applyClaudeCodeIdentity(clone, {
      accessToken: creds.accessToken,
      cliUserID: creds.cliUserID,
      accountUUID: creds.account?.account_uuid ?? null,
      model,
    });
    delete (clone as Record<string, unknown>).metadata;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(COUNT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(clone),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const data = (await res.json()) as { input_tokens?: number };
    return typeof data.input_tokens === "number" ? data.input_tokens : null;
  } catch {
    return null;
  }
}
