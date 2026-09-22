import { recentActivity, subscribeActivity } from "@/lib/activity";
import { namedEvent } from "@/lib/attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent live feed of gateway activity for the dashboard tail. */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  // One per connection: a live feed replays the same few callers on nearly
  // every event, so this is worth memoising for the connection's lifetime and
  // never worth sharing across connections.
  const names = new Map<string, string>();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // closed
        }
      };
      for (const e of recentActivity()) send(namedEvent(e, names));
      const unsub = subscribeActivity((e) => send(namedEvent(e, names)));
      const hb = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": hb\n\n"));
        } catch {
          // closed
        }
      }, 15_000);
      req.signal.addEventListener("abort", () => {
        unsub();
        clearInterval(hb);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
