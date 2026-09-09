---
description: Connect this machine to your gate with the token from your dashboard
argument-hint: <token>
allowed-tools: Bash(node:*)
---

The user gave: $ARGUMENTS

- **Empty** — tell them where the token comes from and stop: their gate dashboard, **Team**
  page, next to their name — *New key* if they have none — which shows a `/gate:login …` line
  to copy whole. Do not guess a token, and do not ask them to paste an API key instead.
- **A token** — connect this machine with it:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" login "<token>"`

The token carries both the gate's address and their personal key, so nothing else is needed and
nothing else should be asked for. It is written to `~/.gate/client.json` (0600) and the command
immediately pulls their team's agents and workflows, so its output already says how many
workflows they have.

It also puts their Claude Code on the gateway, by writing it into `~/.claude/settings.json`
(the `env` block, which Claude Code applies to every session), and writes the team's agents to
`~/.claude/agents/`. Tell them what that means, in a sentence: from now on their own sessions'
model traffic goes through the team's gateway — metered there, on the team's provider keys,
not their personal Claude subscription — and a pipeline's nodes run as subagents they can
watch live. `/gate:live --off --global` reverses it; `/gate:reset` does too.

Then say what they can do next: `/gate:run` alone lists their team's workflows and asks which to
run; `/gate:run <id> <task>` starts one here, in a worktree of the repository they are in; and
the nodes that run in their own model show up live in this terminal, already.

If it refuses, report what it said rather than retrying. An invalid or revoked key, a key that
may not pull workflows, and a token pasted in half each say so in their own words — and a
`CLIENT_TOO_OLD` means this plugin needs `/gate:update` first.
