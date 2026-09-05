import { isExecutionFinished, subscribeWorkflow } from "@/events/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Live execution events (buffered ones first), same SSE shape as /api/activity/stream. */
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // Declared before `close`: subscribeWorkflow replays buffered events
      // synchronously, so a finished run can call close() during subscribe —
      // which would otherwise hit these bindings in their temporal dead zone,
      // throw inside the bus's catch, and leave the stream open forever.
      let unsub: (() => void) | null = null;
      let hb: ReturnType<typeof setInterval> | null = null;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
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
      unsub = subscribeWorkflow(id, (e) => {
        send(e);
        if (e.type === "workflow.completed" || e.type === "workflow.failed") close();
      });
      // The replay above may already have closed the stream.
      if (closed) {
        unsub();
        return;
      }
      hb = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(": hb\n\n"));
        } catch {
          // closed
        }
      }, 15_000);
      req.signal.addEventListener("abort", close);
      // A run that finished before this stream opened replays and ends at once.
      if (isExecutionFinished(id)) close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
