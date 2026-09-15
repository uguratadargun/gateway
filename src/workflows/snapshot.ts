import { createHash } from "node:crypto";

import { parseAgent } from "@/agents/loader";
import { readAgentSource } from "@/agents/registry";
import type { AgentDefinition } from "@/agents/types";
import type { DefinitionScope } from "@/lib/def-root";

import { parseWorkflow } from "./loader";
import { readWorkflowSource } from "./registry";
import type { WorkflowDefinition, WorkflowNode } from "./types";

/**
 * The definitions a run is held to, frozen at its first step.
 *
 * The client already freezes them on its own disk — `pinDefinitions` copies
 * the mirror so a workflow edited mid-run does not move the graph underneath
 * a run halfway through it. This is the other half: the server keeps its own
 * copy, and the two are compared by hash before the run starts.
 *
 * Both halves are needed for different reasons. The client's copy keeps a run
 * walking one graph. The server's copy is what a later report is checked
 * against — a node's role, the output it declared, and which upstream node it
 * is allowed to read — so that a team editing an agent an hour into a run
 * cannot change what the run's own reports are judged by, in either
 * direction.
 *
 * What it is not: proof that the output came from that agent. A client with a
 * token can send whatever it likes under a node's name; the snapshot only
 * fixes *what that name meant*. The narrow powers of the objection protocol
 * are what make that acceptable, and they do not depend on this.
 *
 * Skills are deliberately left out of the hash. A skill changes how well an
 * agent does its work, never what its output means or what it may read, and
 * including them would mismatch a run over a typo fixed in unrelated prose.
 */

export const DEFINITION_SNAPSHOT_VERSION = 1;

export interface DefinitionSnapshot {
  version: number;
  workflowId: string;
  /** Short digest of the workflow and its agents. The thing both sides compare. */
  hash: string;
  /** The workflow's YAML, byte for byte as the run reads it. */
  workflow: string;
  /** Every agent the graph names, by id. */
  agents: Record<string, string>;
  /**
   * Agents the graph names that this side could not read. Kept, rather than
   * dropped, so that a missing agent is a difference between the two sides
   * and not something they silently agree about.
   */
  missing: string[];
}

function sha(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

/** Agent ids the graph names, deduplicated and in a fixed order. */
export function agentsNamedBy(workflow: WorkflowDefinition): string[] {
  return [...new Set(workflow.nodes.flatMap((n) => (n.type === "agent" ? [n.agent] : [])))].sort();
}

function hashOf(workflowId: string, workflow: string, agents: Record<string, string>, missing: string[]): string {
  const lines = [
    ...Object.entries(agents).map(([id, source]) => `a:${id}:${sha(source)}`),
    ...missing.map((id) => `a:${id}:missing`),
  ].sort();
  return createHash("sha256")
    .update([`v:${DEFINITION_SNAPSHOT_VERSION}`, `w:${workflowId}:${sha(workflow)}`, ...lines].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Reads one workflow and the agents it names out of a scope.
 *
 * Sources, not parsed forms: the same bytes are what the client mirrored, so
 * the hash is over the thing both sides actually have. A parsed form would
 * differ across versions of the loader for definitions nobody touched.
 *
 * The graph is read with `agentExists` waved through, and deliberately not
 * through `getWorkflow`: an agent the graph names and nobody can read is the
 * case `missing` exists for, and the run that is starting will fail on that
 * node soon enough with a message about the node. Refusing to take a snapshot
 * over it would mean the one run that most needs its definitions recorded is
 * the one that has none. Whether the workflow may run at all is decided by the
 * caller, which loads it properly.
 */
export function snapshotDefinitions(workflowId: string, scope: DefinitionScope): DefinitionSnapshot {
  const workflow = readWorkflowSource(workflowId, scope);
  const graph = parseWorkflow(workflowId, workflow, {
    sourcePath: `snapshot:${workflowId}`,
    updatedAt: 0,
    agentExists: () => true,
  });
  const agents: Record<string, string> = {};
  const missing: string[] = [];
  for (const id of agentsNamedBy(graph)) {
    try {
      agents[id] = readAgentSource(id, scope);
    } catch {
      missing.push(id);
    }
  }
  return {
    version: DEFINITION_SNAPSHOT_VERSION,
    workflowId,
    hash: hashOf(workflowId, workflow, agents, missing),
    workflow,
    agents,
    missing,
  };
}

/** The same digest without keeping the sources — what the client sends at start. */
export function definitionsHash(workflowId: string, scope: DefinitionScope): string | null {
  try {
    return snapshotDefinitions(workflowId, scope).hash;
  } catch {
    // A workflow that will not load has no hash to agree about, and saying so
    // is the start route's job — not this one's, which is called from a client
    // that is about to fail for a better reason anyway.
    return null;
  }
}

/** A snapshot parsed back into definitions, without touching the filesystem. */
export interface PinnedDefinitions {
  workflow: WorkflowDefinition;
  node(nodeId: string): WorkflowNode | null;
  agent(agentId: string): AgentDefinition | null;
}

// Keyed by hash, which is what a snapshot is: the same hash is the same bytes,
// so a parse can never go stale. Bounded because a busy server sees one entry
// per definition version in flight, not one per run.
const parsed = new Map<string, PinnedDefinitions | null>();
const MAX_PARSED = 64;

/**
 * Parses a snapshot, or returns null when it cannot be parsed at all.
 *
 * Null is not an error to report anywhere: it means this run's recorded
 * definitions tell us nothing, and a report is then judged the way reports
 * were judged before snapshots existed. Refusing a run's steps because the
 * server cannot re-read its own old snapshot would lose real work over a
 * bookkeeping problem.
 */
export function pinnedDefinitions(snapshot: DefinitionSnapshot | null): PinnedDefinitions | null {
  if (!snapshot?.workflow) return null;
  const hit = parsed.get(snapshot.hash);
  if (hit !== undefined) return hit;

  let value: PinnedDefinitions | null = null;
  try {
    const workflow = parseWorkflow(snapshot.workflowId, snapshot.workflow, {
      sourcePath: `snapshot:${snapshot.hash}`,
      updatedAt: 0,
      // The graph was already checked against a real scope when it ran. Here
      // an agent that is only named — because it was missing then too — must
      // not stop the rest of the graph being readable.
      agentExists: () => true,
    });
    const agents = new Map<string, AgentDefinition | null>();
    const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
    value = {
      workflow,
      node: (id) => nodes.get(id) ?? null,
      agent: (id) => {
        if (agents.has(id)) return agents.get(id)!;
        let def: AgentDefinition | null = null;
        const source = snapshot.agents[id];
        if (source) {
          try {
            def = parseAgent(id, source, { sourcePath: `snapshot:${snapshot.hash}`, updatedAt: 0 });
          } catch {
            def = null;
          }
        }
        agents.set(id, def);
        return def;
      },
    };
  } catch {
    value = null;
  }

  if (parsed.size >= MAX_PARSED) parsed.clear();
  parsed.set(snapshot.hash, value);
  return value;
}
