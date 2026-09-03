import { createHash, randomUUID } from "node:crypto";

import {
  CLAUDE_CLI_BILLING_VERSION,
  CLAUDE_CLI_STAINLESS_RUNTIME_VERSION,
  CLAUDE_CODE_SENTINEL,
  CLAUDE_CODE_STAINLESS_VERSION,
  CLAUDE_CODE_VERSION,
} from "./config";

/**
 * Produces the request shape a genuine Claude Code CLI session sends. The
 * `user:sessions:claude_code` OAuth scope expects this shape; without it the
 * token is rejected. Adapted from omniroute's claudeIdentity module.
 */

// One session id per process lifetime (a real CLI run keeps one session).
let processSessionId: string | null = null;
function getSessionId(): string {
  if (!processSessionId) processSessionId = randomUUID();
  return processSessionId;
}

function stainlessOS(): string {
  switch (process.platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "MacOS";
    case "linux":
      return "Linux";
    default:
      return "Unknown";
  }
}

function stainlessArch(): string {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    case "ia32":
      return "x32";
    default:
      return process.arch;
  }
}

/** Deterministic, shape-correct UUIDv4 fallback derived from a seed. */
function uuidV4FromHash(hex64: string): string {
  return [
    hex64.slice(0, 8),
    hex64.slice(8, 12),
    "4" + hex64.slice(13, 16),
    ((parseInt(hex64.charAt(16), 16) & 0x3) | 0x8).toString(16) + hex64.slice(17, 20),
    hex64.slice(20, 32),
  ].join("-");
}

function resolveAccountUUID(realUUID: string | null | undefined, seed: string): string {
  if (realUUID && realUUID.length >= 32) return realUUID;
  return uuidV4FromHash(createHash("sha256").update("account:" + seed).digest("hex"));
}

function buildUserIdJson(deviceId: string, accountUUID: string, sessionId: string): string {
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: accountUUID,
    session_id: sessionId,
  });
}

// --- anthropic-beta selection (gated on request shape + model) -------------

const HEAVY_AGENT_PREFIXES = ["claude-opus", "claude-sonnet"];
const CONTEXT_1M_PREFIXES = ["claude-opus"];
const CONTEXT_1M_NATIVE_PREFIXES = ["claude-opus-5"];

function matches(model: string, prefixes: string[]): boolean {
  const m = model.toLowerCase();
  return prefixes.some((p) => m.includes(p));
}

/**
 * Choose the anthropic-beta flag set that matches the request. Sending the full
 * set on every request is itself a fingerprint, so flags are shape-gated.
 */
export function selectBetaFlags(
  body: Record<string, unknown>,
  model: string,
): string {
  const hasSystem =
    !!body.system &&
    (typeof body.system === "string" ||
      (Array.isArray(body.system) && body.system.length > 0));
  const tools = body.tools as unknown[] | undefined;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const isFullAgent = hasTools && hasSystem;
  const isHeavyAgent = isFullAgent && matches(model, HEAVY_AGENT_PREFIXES);
  const isContext1m =
    isFullAgent &&
    matches(model, CONTEXT_1M_PREFIXES) &&
    !matches(model, CONTEXT_1M_NATIVE_PREFIXES);

  const flags: string[] = [];
  if (isFullAgent) flags.push("claude-code-20250219");
  flags.push("oauth-2025-04-20");
  if (isContext1m) flags.push("context-1m-2025-08-07");
  flags.push(
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
  );
  if (isFullAgent) flags.push("extended-cache-ttl-2025-04-11");
  if (isHeavyAgent) flags.push("advanced-tool-use-2025-11-20", "effort-2025-11-24");
  return flags.join(",");
}

/**
 * Mutate the request body in place to carry the Claude Code system sentinel
 * (+ billing line) and metadata.user_id, and return the outbound headers.
 */
export function applyClaudeCodeIdentity(
  body: Record<string, unknown>,
  opts: { accessToken: string; cliUserID: string; accountUUID: string | null; model: string },
): Record<string, string> {
  const sessionId = getSessionId();
  const deviceId = opts.cliUserID;
  const accountUUID = resolveAccountUUID(opts.accountUUID, deviceId);

  const billingLine = `x-anthropic-billing-header: cc_version=${CLAUDE_CLI_BILLING_VERSION}; cc_entrypoint=cli; cch=00000;`;

  const sysBlocks: Array<Record<string, unknown>> = Array.isArray(body.system)
    ? (body.system as Array<Record<string, unknown>>)
    : typeof body.system === "string"
      ? [{ type: "text", text: body.system }]
      : [];

  // Strip any pre-existing billing/sentinel so retries stay idempotent and the
  // prompt-cache prefix stays stable.
  for (let i = sysBlocks.length - 1; i >= 0; i--) {
    const t = sysBlocks[i]?.text;
    if (typeof t === "string" && (t.startsWith("x-anthropic-billing-header:") || t.startsWith(CLAUDE_CODE_SENTINEL))) {
      sysBlocks.splice(i, 1);
    }
  }
  sysBlocks.unshift(
    { type: "text", text: billingLine },
    { type: "text", text: CLAUDE_CODE_SENTINEL },
  );
  body.system = sysBlocks;

  if (!body.metadata || typeof body.metadata !== "object") body.metadata = {};
  (body.metadata as Record<string, unknown>).user_id = buildUserIdJson(
    deviceId,
    accountUUID,
    sessionId,
  );

  return {
    Authorization: `Bearer ${opts.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": selectBetaFlags(body, opts.model),
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    "X-Stainless-Package-Version": CLAUDE_CODE_STAINLESS_VERSION,
    "X-Stainless-Timeout": "600",
    "X-Stainless-Lang": "js",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": CLAUDE_CLI_STAINLESS_RUNTIME_VERSION,
    "X-Stainless-Arch": stainlessArch(),
    "X-Stainless-OS": stainlessOS(),
    "X-Stainless-Retry-Count": "0",
    "x-client-request-id": randomUUID(),
    "X-Claude-Code-Session-Id": sessionId,
    "accept-encoding": "gzip, deflate, br, zstd",
  };
}
