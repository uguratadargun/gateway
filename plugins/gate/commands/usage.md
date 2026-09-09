---
description: How much of the gate's quota is left, and when it resets
allowed-tools: Bash(node:*)
---

What the pool has left right now:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" usage`

Report those numbers, and say what they are — because they are not the ones Claude Code's own
`/usage` shows, and that command is gone here:

- **`/usage` needs a Claude subscription login.** It reads Anthropic's usage endpoint with that
  login's OAuth scopes. A session on the gateway authenticates with a gate key instead, so the
  command hides itself and shows nothing. Nothing is broken; there is simply no personal plan
  behind this session any more.
- **These are the windows of the accounts gate rotates** — the quota that actually stops the
  work — and they are **shared**: everyone on this gate draws from the same pool, so the number
  can move without this session doing anything.
- The percentage is the **best account that can serve**, not an average of all of them: one
  fresh account means a fresh window, whatever the others are at.

If a window is low, the useful next line is when it resets — that is in the output — and, if the
gate has more than one account, that the pool moves to another on its own. If it printed a reason
instead of windows (no account connected, none polled yet, a refused poll), report that as it is
rather than treating it as an error the user did something to cause.

The dashboard's accounts card is where an account is added, paused or reordered; this command
only reads.
