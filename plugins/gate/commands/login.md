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

It also writes the team's agents to `~/.claude/agents/`, so a pipeline's nodes run as subagents
they can watch live. Tell them, in a sentence, that every model call a run makes is their own
Claude Code login — gate holds no Claude account and serves no models; it keeps the team's
definitions, the runs and the memory. If the output says it took gate's old gateway settings
out of their Claude Code settings, tell them to restart Claude Code once.

Say in one more sentence that a run pushes its branch and opens the merge request from this
machine, with its own git access: a GitHub repository needs `gh auth login` here, a GitLab one
works with the SSH key alone (or `glab auth login`).

Then say what they can do next: `/gate:run` alone lists their team's workflows and asks which to
run; `/gate:run <id> <task>` starts one here, in a worktree of the repository they are in; and
the nodes that run in their own model show up live in this terminal.

In a terminal the same login is `~/.local/bin/gate login <token>`, written there by the plugin
on every session start.

If it refuses, report what it said rather than retrying. An invalid or revoked key, a key that
may not pull workflows, and a token pasted in half each say so in their own words — and a
`CLIENT_TOO_OLD` means this plugin needs `/gate:update` first.
