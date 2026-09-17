import { gateAuthOk } from "@/lib/gate-auth";
import { jsonError } from "@/lib/gateway-core";
import { providerCatalogue } from "@/lib/providers";
import { fetchAvailableModels } from "@/lib/models";
import { loadRoutingConfig } from "@/lib/router";

export const runtime = "nodejs";

/**
 * Model list in a shape both Anthropic and OpenAI SDKs accept. Lists the gate
 * tier aliases first (haiku/sonnet/opus/fable), then the account's models,
 * then every provider model — so a client can name one directly rather than
 * going through a tier.
 */
export async function GET(req: Request) {
  if (!gateAuthOk(req)) return jsonError(401, "Invalid gate API key");
  const { models } = await fetchAvailableModels();
  const fromProviders = await providerCatalogue();
  const cfg = loadRoutingConfig();
  const created = Math.floor(Date.now() / 1000);
  // `display_name` and `description` are the two optional fields Claude Code's
  // own gateway discovery reads, so a provider model is named the same way
  // whether the picker row was written by gate or discovered by the client.
  const entry = (id: string, owned_by: string, display_name = id, description?: string) => ({
    id,
    object: "model",
    type: "model",
    display_name,
    ...(description ? { description } : {}),
    created,
    created_at: new Date(created * 1000).toISOString(),
    owned_by,
  });
  const data = [
    ...Object.keys(cfg.tiers).map((t) => entry(t, "gate")),
    ...models.map((m) => entry(m, "anthropic")),
    ...fromProviders.map((m) => entry(m.id, m.owner, m.display_name, m.description)),
  ];
  return Response.json({ object: "list", data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
}
