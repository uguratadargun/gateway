---
description: Disconnect this machine from gate and clear what it pulled
allowed-tools: Bash(node:*)
---

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" reset`

It clears **this machine only**: the login, the mirror of the team's agents and workflows, the
approvals given for running workflows here, the gateway from Claude Code's settings (user's and
this repository's) and the subagents gate wrote to `~/.claude/agents/`. Report what it printed.

Nothing anyone else can see changes. The team's definitions live on the server and stay there —
if the user wants those deleted, that is the dashboard's Agents and Workflows pages, where they can
see what they are removing and it is one team's decision rather than one machine's. Say that rather
than looking for a flag; there is not one.

Run history and API keys are also untouched (both live in the dashboard), and so are the worktrees
previous runs produced — those are branches with work in them, and the command says where they are.

Afterwards the machine is as it was before anyone logged in: `/gate:login <token>` connects it
again, with a token from the dashboard's Team page.
