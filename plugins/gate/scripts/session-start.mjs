#!/usr/bin/env node
import { appendFileSync } from "node:fs";

/**
 * SessionStart hook: tells the `gate` CLI which Claude Code session it runs in.
 *
 * A run /gate:run drives does some of its nodes in the session itself, and
 * the session's model calls reach the gateway under the session's own id —
 * not under the run's. The CLI cannot see that id from a Bash tool call, but
 * this hook can: Claude Code hands it the session on stdin and, where it
 * supports it, a file whose exports become the session's environment. One
 * line there, and every `gate begin` in this session names the session, so
 * the server can cost the nodes the session did against the run.
 *
 * Silent when nothing applies: an old Claude Code with no env file, or stdin
 * that is not the hook's JSON, is a session whose runs are simply not costed.
 */
const envFile = process.env.CLAUDE_ENV_FILE;
if (!envFile) process.exit(0);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let id = "";
  try {
    id = String(JSON.parse(raw).session_id ?? "");
  } catch {
    // Not the hook's JSON; nothing to record.
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) process.exit(0);
  try {
    appendFileSync(envFile, `export GATE_CLAUDE_SESSION=${id}\n`);
  } catch {
    // An env file that cannot be written is a session that is not costed.
  }
});
