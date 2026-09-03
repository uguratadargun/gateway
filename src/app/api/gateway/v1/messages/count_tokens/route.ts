import { countTokens } from "@/lib/count-tokens";
import { gateAuthOk } from "@/lib/gate-auth";
import { jsonError } from "@/lib/gateway-core";
import { routeModel } from "@/lib/router";

export const runtime = "nodejs";

/** Anthropic count_tokens proxy; resolves gate aliases (auto/haiku/…) first. */
export async function POST(req: Request) {
  if (!gateAuthOk(req)) return jsonError(401, "Invalid gate API key");
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }
  const route = routeModel(typeof body.model === "string" ? body.model : undefined, body);
  const n = await countTokens(body, route.model);
  if (n == null) return jsonError(502, "count_tokens unavailable");
  return Response.json({ input_tokens: n }, { headers: { "x-gate-model": route.model } });
}
