import { requireRemote } from "@/remote/auth";
import { remoteManager } from "@/remote/manager";
import type { RemoteFrame } from "@/remote/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The caller's remote sessions, live, on one connection: a hello with every
 * session and everything waiting, each live terminal's recent screen, then
 * terminal output, exits and list changes as they happen. A cockpit that
 * drops and reconnects gets the same opening again, so nothing it missed
 * while away needs a second request.
 */
export async function GET(req: Request) {
  const auth = requireRemote(req);
  if (auth instanceof Response) return auth;

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsub: (() => void) | null = null;
      let hb: ReturnType<typeof setInterval> | null = null;
      const send = (frame: RemoteFrame) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          // closed
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        unsub?.();
        if (hb) clearInterval(hb);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      unsub = remoteManager().subscribe(auth.principal, send);
      hb = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(": hb\n\n"));
        } catch {
          // closed
        }
      }, 15_000);
      req.signal.addEventListener("abort", close);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
