---
description: Disconnect this machine from gate and clear what it pulled
argument-hint: [--team]
allowed-tools: Bash(node:*)
---

The user asked: $ARGUMENTS

Two different things can be reset, and they are not the same size:

- **This machine** (the default) — the login, the mirror of the team's definitions, and the
  approvals given for running workflows here. Nothing anyone else can see changes; the person
  reconnects with `/gate:login <token>` and the definitions come back on the next command.
  Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" reset`
- **The team's definitions on the server** (`--team`, only if they clearly asked for that) — every
  agent and workflow the team owns, deleted for everyone on it. Run:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" reset --team`
  It asks for the team's name to be typed back before it does anything, and refuses without a
  terminal. Do not pass `--yes` on the user's behalf, and do not run this because they said
  "reset" alone — ask which one they meant.

Neither touches run history, worktrees, or API keys: history and keys live in the dashboard, and a
worktree is work someone's run produced — say where they are rather than removing them.

Report what it printed. If they wanted a clean machine to test onboarding, tell them the next step
is `/gate:login <token>` with a token from the dashboard's Team page.
