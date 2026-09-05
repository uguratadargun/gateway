/**
 * Node-only startup daemon: keeps the Claude token warm by refreshing it well
 * before expiry so gateway requests never block on a cold refresh, and settles
 * any workflow run the previous process left open. Imported only from
 * instrumentation.ts under the nodejs-runtime guard.
 */
import { failInterruptedExecutions } from "@/executions/store";
import { getValidCredentials } from "@/lib/token-manager";

const g = globalThis as unknown as { __gateDaemon?: boolean };

if (!g.__gateDaemon) {
  g.__gateDaemon = true;

  const tick = async () => {
    try {
      await getValidCredentials(); // refreshes if within the lead window
    } catch {
      // best-effort; a failed refresh surfaces on the next real request
    }
  };

  // Nothing that was running when this process started can still be running.
  try {
    failInterruptedExecutions();
  } catch {
    // A missing or locked database is reported by the first real request.
  }

  setInterval(tick, 10 * 60 * 1000).unref?.();
  void tick();
}
