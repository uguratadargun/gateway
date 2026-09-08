import { NextResponse } from "next/server";

import { formatProviderRef, listProviders, listProviderModels } from "@/lib/providers";
import { fetchAvailableModels } from "@/lib/models";

export const runtime = "nodejs";

/**
 * Everything a tier or an agent can be pointed at: the models the connected
 * Claude account exposes, plus every model each enabled provider serves.
 * `models` is the flat list the pickers bind to; `groups` labels where each one
 * comes from, and whether that group is on this network or out on the internet.
 */
export async function GET() {
  const anthropic = await fetchAvailableModels();
  const providers = listProviders().filter((p) => p.enabled);

  const providerGroups = await Promise.all(
    providers.map(async (p) => {
      const { models, error } = await listProviderModels(p);
      return {
        label: p.label,
        kind: "provider" as const,
        dialect: p.kind,
        selfHosted: p.selfHosted,
        models: models.map((m) => formatProviderRef(p.name, m)),
        error,
      };
    }),
  );

  return NextResponse.json({
    models: [...anthropic.models, ...providerGroups.flatMap((g) => g.models)],
    source: anthropic.source,
    groups: [
      {
        label: "Claude",
        kind: "anthropic" as const,
        dialect: "anthropic-compat" as const,
        selfHosted: false,
        models: anthropic.models,
        error: null,
      },
      ...providerGroups,
    ],
  });
}
