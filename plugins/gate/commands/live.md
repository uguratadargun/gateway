---
description: Watch pipeline nodes live in this terminal — put Claude Code here on the gateway
argument-hint: [--global | --off]
allowed-tools: Bash(node:*)
---

The user gave: $ARGUMENTS

A node that runs in its own model (`executor: claude-code` — the shipped planner, implementer
and reviewer) can run in one of two ways on this machine. As a detached worker it is out of
sight: the session follows a log and relays it after each `gate wait`. As a **subagent of this
session** it is drawn live here — every read, every edit as a diff, every command — the way
your own work is. The second needs the session's own model calls to go through the gateway,
because a subagent inherits the session's endpoint and the agent's model is a name only the
gateway resolves.

This command makes that the default for Claude Code started in this repository, by writing
the gateway into `.claude/settings.local.json` here (Claude Code applies its `env` block to
every session, and the file stays out of git). It also sets `disableClaudeAiConnectors`
there: on the gateway the claude.ai connectors do not load anyway, and that setting is what
stops Claude Code saying so in the prompt bar of every session. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" live $ARGUMENTS
```

- no arguments — this repository;
- `--global` — every Claude Code session of this user, written to `~/.claude/settings.json`;
- `--off` — take it out again (with `--global` for the user's settings).

Then tell the user what it printed, and two things it does not say:

- **Their own session's model traffic goes through the gateway too**, from now on, on the
  team's provider keys — not their personal Claude subscription — and shows up in the gate
  dashboard like a run's does. That is what makes the live view possible and it is their call;
  `--off` reverses it.
- A session already open here picks the change up on its own. If the next node in its own
  model still arrives as `wait` rather than as a subagent, restarting Claude Code once fixes it.

If it refuses (not logged in, a settings file that is not JSON), report what it said.
