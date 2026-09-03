import { gateAuthOk } from "@/lib/gate-auth";
import { jsonError } from "@/lib/gateway-core";
import { fetchAvailableModels } from "@/lib/models";
import { loadRoutingConfig } from "@/lib/router";

export const runtime = "nodejs";

/**
 * Model list in a shape both Anthropic and OpenAI SDKs accept. Lists the gate
 * tier aliases first (auto/haiku/sonnet/opus/fable), then the account's models.
 */
export async function GET(req: Request) {
  if (!gateAuthOk(req)) return jsonError(401, "Invalid gate API key");
  const { models } = await fetchAvailableModels();
  const cfg = loadRoutingConfig();
  const created = Math.floor(Date.now() / 1000);
  const entry = (id: string, owned_by: string) => ({
    id,
    object: "model",
    type: "model",
    display_name: id,
    created,
    created_at: new Date(created * 1000).toISOString(),
    owned_by,
  });
  const data = [
    entry("auto", "gate"),
    ...Object.keys(cfg.tiers).map((t) => entry(t, "gate")),
    ...models.map((m) => entry(m, "anthropic")),
  ];
  return Response.json({ object: "list", data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
}
