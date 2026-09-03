/**
 * Claude Code OAuth configuration.
 *
 * This is the same Authorization-Code-with-PKCE flow the official Claude Code
 * CLI uses. The client_id below is the public Claude Code desktop/CLI client
 * (public by design — PKCE protects the flow, not client-secret confidentiality,
 * per RFC 8252). It can be overridden via env for forward-compatibility.
 */
export const CLAUDE_OAUTH = {
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://api.anthropic.com/v1/oauth/token",
  // Anthropic's hosted callback that displays the code+state for manual paste,
  // exactly like Claude Code's headless login. No local server required.
  redirectUri:
    process.env.CLAUDE_OAUTH_REDIRECT_URI ||
    "https://platform.claude.com/oauth/code/callback",
  scopes: [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
  ],
  codeChallengeMethod: "S256" as const,
} as const;

export const ANTHROPIC_API_BASE = "https://api.anthropic.com";
export const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_API_BASE}/v1/messages`;
export const ANTHROPIC_BOOTSTRAP_URL = `${ANTHROPIC_API_BASE}/api/claude_cli/bootstrap`;

/**
 * Pinned Claude Code CLI wire-image versions. These identify the request as a
 * genuine Claude Code session — required for the `user:sessions:claude_code`
 * scope to be accepted. Bump in lockstep when a newer CLI release is captured.
 */
// Pinned to the installed Claude Code CLI (2.1.259) so gate's wire image matches
// the real client. 2.1.251+ is required by Anthropic for the newest models.
export const CLAUDE_CODE_VERSION = process.env.CLAUDE_CODE_VERSION || "2.1.259";
export const CLAUDE_CODE_STAINLESS_VERSION =
  process.env.CLAUDE_CODE_STAINLESS_VERSION || "0.112.1";
export const CLAUDE_CLI_STAINLESS_RUNTIME_VERSION = "v22.14.0";
export const CLAUDE_CLI_BILLING_VERSION = CLAUDE_CODE_VERSION;

/** Anthropic system-prompt sentinel that marks the request as Claude Code. */
export const CLAUDE_CODE_SENTINEL =
  "You are Claude Code, Anthropic's official CLI for Claude.";
