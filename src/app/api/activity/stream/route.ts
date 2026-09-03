import { recentActivity, subscribeActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent live feed of gateway activity for the dashboard tail. */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // closed
        }
      };
      for (const e of recentActivity()) send(e);
      const unsub = subscribeActivity(send);
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
