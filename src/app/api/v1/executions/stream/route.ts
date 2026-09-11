import { subscribeAllWorkflows } from "@/events/bus";
import type { WorkflowEvent } from "@/events/types";
import { getExecution, listExecutions } from "@/executions/store";
import { ownsExecution, requireClient } from "@/lib/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The caller's runs, live, on one connection.
 *
 * A cockpit following five runs wants one stream, not five: this one opens
 * with a snapshot of the person's unfinished runs — so what is paused on them
 * shows before anything happens — and then carries every event of every run
 * they own, as `/api/executions/<id>/stream` does for one. Ownership is the
 * client API's rule everywhere: their own runs, never a teammate's. A run
 * that starts after the stream opened is admitted on its first event, since
 * the row exists before the machine running it reports anything.
 */
export async function GET(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsub: (() => void) | null = null;
      let hb: ReturnType<typeof setInterval> | null = null;
      // Decided once per run for the life of the stream: ownership never changes.
      const admitted = new Map<string, boolean>();
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
      const mine = (executionId: string): boolean => {
        const known = admitted.get(executionId);
        if (known !== undefined) return known;
        const execution = getExecution(executionId);
        const ok = execution ? ownsExecution(execution, auth) : false;
        // An unknown run stays undecided: it may be created a beat later.
        if (execution) admitted.set(executionId, ok);
        return ok;
      };

      const open = listExecutions({ teamId: auth.teamId, userId: auth.userId ?? undefined, limit: 100 }).filter(
        (e) => e.status === "running",
      );
      for (const e of open) admitted.set(e.id, true);
      send({ type: "snapshot", at: Date.now(), executions: open });

      unsub = subscribeAllWorkflows((e: WorkflowEvent) => {
        if (mine(e.executionId)) send(e);
      });
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
