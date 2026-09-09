import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { listAgents } from "@/agents/registry";
import type { AgentDefinition } from "@/agents/types";
import type { DefinitionScope } from "@/lib/def-root";

/**
 * The team's claude-code agents, as subagents of the person's own Claude Code.
 *
 * A node that runs in its own model has two ways to run on this machine. As
 * a detached worker it is invisible until `gate wait` relays its log; as a
 * subagent of the session it is drawn live in the terminal the way the
 * session's own work is — every read, every edit as a diff, every command —
 * and the person can stop it. The second needs Claude Code to know the agent:
 * a file under ~/.claude/agents/ whose `model:` is the agent's model, which
 * Claude Code passes straight to the API and gate's gateway routes to the
 * provider. So this mirrors the team's agents there, one file each, and
 * removes what the team no longer has. Claude Code watches the directory,
 * so an edit lands within seconds; only the directory's very first file
 * needs a restart to be seen.
 */

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function subagentName(team: string, agentId: string): string {
  return `gate-${team}-${agentId}`;
}

function subagentFile(team: string, agent: AgentDefinition): string {
  const name = subagentName(team, agent.id);
  return `---
name: ${name}
description: gate's "${agent.id}" agent for team "${team}". Only /gate:run starts it; it is not for other work.
model: ${agent.model}
---

You are the \`${agent.id}\` agent of a gate run, started by the session driving the run. The
task you are given is the whole brief: what to do, the worktree to do it in, the skill files
to read and follow first, the shape of the answer to end with, and — at its end — the terms
under which you run unattended. Work only in the worktree the task names, with absolute paths
under it, and nowhere else. End your final message with the answer in exactly the shape the
task asks for, and nothing after it.
`;
}

/** Removes every subagent file gate wrote, whichever team: what `gate reset` does. */
export function removeSubagents(): string[] {
  const dir = join(claudeConfigDir(), "agents");
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!/^gate-[a-z0-9-]+\.md$/.test(entry)) continue;
    const text = readFileSync(join(dir, entry), "utf8");
    // Only what gate wrote: a person's own agent that happens to start with
    // "gate-" does not carry this line.
    if (!text.includes("Only /gate:run starts it")) continue;
    rmSync(join(dir, entry));
    removed.push(entry.slice(0, -3));
  }
  return removed;
}

/**
 * Writes the team's claude-code agents as subagent files, and removes the
 * team's files for agents that are gone. Returns what changed, and whether
 * the directory was created — the one case Claude Code needs a restart for.
 */
export function syncSubagents(team: string, scope: DefinitionScope): { written: string[]; removed: string[]; created: boolean } {
  const dir = join(claudeConfigDir(), "agents");
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prefix = `gate-${team}-`;
  const wanted = new Map<string, string>();
  for (const agent of listAgents(scope).agents) {
    if (agent.executor === "claude-code") wanted.set(`${subagentName(team, agent.id)}.md`, subagentFile(team, agent));
  }
  const written: string[] = [];
  const removed: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".md") || wanted.has(entry)) continue;
    rmSync(join(dir, entry));
    removed.push(entry.slice(0, -3));
  }
  for (const [file, content] of wanted) {
    const path = join(dir, file);
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      // Not there yet.
    }
    if (current === content) continue;
    writeFileSync(path, content, { mode: 0o600 });
    written.push(file.slice(0, -3));
  }
  return { written, removed, created };
}
