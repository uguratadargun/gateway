Status: done
Branch: feat/remove-skills-and-dev-super
Decisions: docs/decisions/0063-agents-follow-no-skills.md
Design: docs/design/agents.md, docs/design/dev-workflow.md, docs/design/dashboard.md, docs/design/teams-and-keys.md, docs/design/workflows-engine.md, docs/ARCHITECTURE.md

# Removing skills and dev-super

## What was asked

Remove the Skills section and remove `dev-super` from the workflows. Asked
how far, the person chose the whole skills subsystem (the Skills page, skill
libraries, the skill APIs, the `skills:` field on agents, the run's skill
copies) and the four `super-*` agents along with `dev-super`.

## What counted as done

- Nothing in gate reads a skill: no Skills page or sidebar entry, no skill or
  skill-source API, no skills in the bundle or the client's mirror, no skill
  paths in a node's instruction, no `skills:check` script.
- An agent file that still names `skills` loads and runs; the editor's form
  drops the line on save.
- The database drops `skill_sources`, and gate's clones under
  `~/.gate/skill-sources/` go, on the first open. A team's own imported
  copies stay.
- `dev-super` and the `super-*` agents are not shipped, and
  `defaults:restore --refresh` moves a scope's copies under
  `backups/<stamp>/`, the workflow before the agents.
- The three notices a `claude-code` node is given stay, in
  `src/client/notices.ts`, worded without skills.
- The design docs, architecture, README and the plugin's commands and
  authoring reference describe gate without skills or `dev-super`; the
  agents design doc is renamed `agents.md`.
- Version 0.51.0 across `plugin.json`, `marketplace.json` and
  `GATE_VERSION`; `npm run typecheck`, `npm test` and `npm run docs:check`
  pass.
