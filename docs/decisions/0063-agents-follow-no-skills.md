# 0063. Agents follow no skills, and dev-super is gone

Status: accepted
Date: 2026-10-06
Run: manual

## Context

An agent could name skills from its team's library: `SKILL.md` directories pulled from a git library on the dashboard's Skills page, mirrored to each machine with the team's definitions, and handed to the node as paths to read and follow. Since 0.30.0 the shipped `dev` agents follow no skill and carry their method in the prompt. Only `dev-super` used skills: `dev`'s graph on four `super-*` agents bound to the superpowers skills. On the same task it was measured at about eighty minutes against `dev`'s fifty-nine, and most of the difference was the skills' own ceremony. Keeping it meant a library sync and import flow, an anchor check that tied four prompts to another project's wording, a skill mirror in every bundle, and a resolution step in front of every agent node.

## Decision

Agents no longer follow skills. The skill library, its sources, the Skills page, the bundle's skill files and the node's skill paths are removed. The `dev-super` pipeline and the four `super-*` agents are no longer shipped.

## Rationale

A method that a pipeline depends on belongs in the prompt that the pipeline ships, where a test can hold it and a reviewer can read it. One shipped road for a planned change is easier to choose, test and keep true than two roads that differ only in which method their agents follow.

## Alternatives

Remove only the Skills page and keep the `skills:` field for skills written by hand. Then the mirror, the pin resolution and the save-time check stay for a field no shipped agent uses, and a team would still have to build its own library to use it.

Keep `dev-super` and drop only the import flow. Its agents' prompts are written against the superpowers text, so without the import nobody can run it.

Reject agent files that still name `skills`. An agent file written for an older gate would then stop loading, and a team's whole agent list would show an error for one line nothing reads.

## How it works

The agent schema still accepts `skills`, like `maxTokens`, and nothing reads it. The editor's form does not carry it, so a save from the editor drops it. A node's instruction has no skill field, and `gate next` resolves nothing before it hands out a node. The bundle carries agents and workflows only, and a pull removes the old `skills` directory from the mirror. On the first open, the database drops `skill_sources` and gate's clones under `~/.gate/skill-sources/`. A team's imported copies under `teams/<team>/skills/` are its own files and are left alone. `defaults:restore --refresh` moves a scope's own `dev-super.yaml` to `backups/<stamp>/workflows/` first and the `super-*` agents to `backups/<stamp>/agents/` after, because a pipeline that names an agent that is gone does not load. The three notices for a `claude-code` node stay, in `src/client/notices.ts`.

## Consequences

A team that ran `dev-super` runs `dev`. A team that wrote its own agent around a skill has to put that method into the agent's prompt; the agent still runs, but nothing tells it about the skill. Until `--refresh` runs on a gate, its `dev-super` and `super-*` files stay in place, and their prompts point at skill files that no node is given. The descriptions of `dev` and `dev-quick` no longer mention skills, so once a gate is refreshed, each machine asks for the first-run approval of those two again, because an approval holds for one exact source.

## Touches

- `src/agents/types.ts`
- `src/agents/form.ts`
- `src/agents/registry.ts`
- `src/agents/defaults.ts`
- `src/workflows/defaults.ts`
- `src/client/step.ts`
- `src/client/notices.ts`
- `src/client/cache.ts`
- `src/app/api/v1/bundle/route.ts`
- `src/lib/db.ts`
- `src/scripts/restore-defaults.ts`
- `docs/design/agents.md`
- `docs/design/dev-workflow.md`
- agents
- dev-workflow

## Supersedes

0054
