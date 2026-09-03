import { ANTHROPIC_API_BASE, CLAUDE_CODE_VERSION } from "@/lib/claude/config";
import { gateAuthOk } from "@/lib/gate-auth";
import { jsonError } from "@/lib/gateway-core";
import { getValidCredentials } from "@/lib/token-manager";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Thin authenticated proxy for the Anthropic Message Batches API. Batch items
 * carry their own model, so gate does not route them — it just forwards on your
 * OAuth token. Supports create/list/get/results/cancel via the catch-all path.
 */
async function proxy(req: Request, path: string[] | undefined): Promise<Response> {
  if (!gateAuthOk(req)) return jsonError(401, "Invalid gate API key");

  const creds = await getValidCredentials();
  if (!creds) return jsonError(401, "No Claude account connected.");

  const suffix = path?.length ? "/" + path.map(encodeURIComponent).join("/") : "";
  const url = `${ANTHROPIC_API_BASE}/v1/messages/batches${suffix}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20,message-batches-2024-09-24",
    "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
  };

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const bodyText = await req.text();
    if (bodyText) {
      headers["Content-Type"] = "application/json";
      init.body = bodyText;
    }
  }

  const upstream = await fetch(url + (new URL(req.url).search || ""), init);
  const respHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) respHeaders.set("content-type", ct);
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

export async function POST(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, (await ctx.params).path);
}
export async function GET(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  return proxy(req, (await ctx.params).path);
}
