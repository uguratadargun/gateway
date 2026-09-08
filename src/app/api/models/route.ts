import { NextResponse } from "next/server";

import { formatLocalRef, listProviders, listProviderModels } from "@/lib/local-providers";
import { fetchAvailableModels } from "@/lib/models";

export const runtime = "nodejs";

/**
 * Everything a tier can be pointed at: the models the connected Claude account
 * exposes, plus every model each enabled local provider serves. `models` is the
 * flat list the pickers bind to; `groups` labels where each one comes from.
 */
export async function GET() {
  const anthropic = await fetchAvailableModels();
  const providers = listProviders().filter((p) => p.enabled);

  const localGroups = await Promise.all(
    providers.map(async (p) => {
      const { models, error } = await listProviderModels(p);
      return { label: p.label, kind: "local" as const, models: models.map((m) => formatLocalRef(p.name, m)), error };
    }),
  );

  return NextResponse.json({
    models: [...anthropic.models, ...localGroups.flatMap((g) => g.models)],
    source: anthropic.source,
    groups: [
      { label: "Claude", kind: "anthropic" as const, models: anthropic.models, error: null },
      ...localGroups,
    ],
  });
}
