import { NextResponse } from "next/server";

import { formatLocalRef, getProvider, listProviderModels } from "@/lib/local-providers";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * Live catalogue for one endpoint, which doubles as the connection test:
 * an unreachable box comes back with the reason rather than an empty list.
 */
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const provider = getProvider(id);
  if (!provider) return NextResponse.json({ error: "No such provider" }, { status: 404 });

  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const { models, error } = await listProviderModels(provider, { force });
  return NextResponse.json({
    models,
    refs: models.map((m) => formatLocalRef(provider.name, m)),
    error,
    baseUrl: provider.baseUrl,
    selfHosted: provider.selfHosted,
  });
}
