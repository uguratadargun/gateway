import { gateAuthOk } from "@/lib/gate-auth";
import { executeMessages, jsonError } from "@/lib/gateway-core";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Anthropic-compatible messages endpoint. Point any Anthropic SDK / Claude Code
 * client at `<host>/api/gateway` as its base URL.
 */
export async function POST(req: Request) {
  if (!gateAuthOk(req)) return jsonError(401, "Invalid gate API key");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  return executeMessages(body, {
    stream: body.stream === true,
    clientBeta: req.headers.get("anthropic-beta"),
    effortHeader: req.headers.get("x-gate-effort"),
  });
}
