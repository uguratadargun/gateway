---
description: Update the gate plugin to the latest published version
allowed-tools: Bash(claude:*), Bash(node:*)
---

This plugin is installed from the `gateway` marketplace, and updates arrive in two steps: the
marketplace is refreshed from its source, then the plugin is re-installed from it.

Installed right now:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" version`

Do this:

1. `claude plugin marketplace update gateway`
2. `claude plugin update gate@gateway -y` — `-y` is required because this is not running on a
   terminal.
3. Report what they printed, then tell the user to **restart Claude Code**: an update is fetched
   immediately but the commands and the bundled CLI are only loaded at startup. Until they do,
   `/gate:run` and the rest are still the old ones.

If the version does not move, say so rather than reporting success. It usually means the published
`plugin.json` version is unchanged — installs are cached by version, so a plugin whose contents
changed while its number did not is fetched and then ignored. That is a problem where the plugin is
published, not here, and nothing this command does can work around it.
