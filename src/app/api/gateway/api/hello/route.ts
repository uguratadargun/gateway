export const runtime = "nodejs";

/** Claude Code probes `${ANTHROPIC_BASE_URL}/api/hello` as a connectivity check. */
export async function GET() {
  return Response.json({ ok: true, service: "gate" });
}
export async function HEAD() {
  return new Response(null, { status: 200 });
}
