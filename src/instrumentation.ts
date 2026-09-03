/**
 * Server-startup hook. Node-only daemon code lives in a separate module that is
 * imported strictly under the nodejs-runtime guard, so webpack never pulls
 * node: built-ins into the edge instrumentation bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
