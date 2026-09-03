import { hasActiveKeys, verifyKey } from "./apikeys";

/** Auth: an issued gate key (if any exist) or the GATE_API_KEY env, else open. */
export function gateAuthOk(req: Request): boolean {
  const header = req.headers.get("authorization") || req.headers.get("x-api-key") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (hasActiveKeys()) return verifyKey(token);
  const required = process.env.GATE_API_KEY;
  if (required) return token === required;
  return true; // local-only, no keys configured
}
