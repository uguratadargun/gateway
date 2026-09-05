import { load as parseYaml } from "js-yaml";

import { WorkflowError } from "@/runtime/errors";

import { ConditionError, conditionPaths, parseCondition } from "./condition";
import { successorsOf, workflowDefinitionSchema, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from "./types";

/** Parsing, schema validation and structural checks. No filesystem access. */

export interface ParseWorkflowOptions {
  sourcePath: string;
  updatedAt: number;
  /** Optional agent existence check, so a broken reference fails at load time. */
  agentExists?: (agentId: string) => boolean;
}

function invalid(id: string, message: string): WorkflowError {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message, { workflowId: id });
}

export function parseWorkflow(id: string, raw: string, opts: ParseWorkflowOptions): WorkflowDefinition {
  let doc: unknown;
  try {
    doc = parseYaml(raw) ?? {};
  } catch (e) {
    throw invalid(id, `invalid YAML: ${(e as Error).message}`);
  }

  const parsed = workflowDefinitionSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw invalid(id, detail);
  }

  const nodes = parsed.data.nodes.map((n) => normalizeEdges(id, n));
  const wf: WorkflowDefinition = {
    ...parsed.data,
    id,
    nodes,
    sourcePath: opts.sourcePath,
    updatedAt: opts.updatedAt,
  };
  validateStructure(wf, opts);
  return wf;
}

function normalizeEdges(workflowId: string, node: ReturnType<typeof workflowDefinitionSchema.parse>["nodes"][number]): WorkflowNode {
  // Terminal and parallel nodes route through their own fields, not edges.
  if (node.type === "terminal" || node.type === "parallel") return { ...node, edges: [] };
  if (node.next && node.edges?.length) {
    throw invalid(workflowId, `node "${node.id}": use either "next" or "edges", not both`);
  }
  const raw = node.next ? [{ to: node.next }] : (node.edges ?? []);
  const edges: WorkflowEdge[] = raw.map((e) => {
    if (!e.when) return { ...e, condition: null };
    try {
      return { ...e, condition: parseCondition(e.when) };
    } catch (err) {
      const message = err instanceof ConditionError ? err.message : String(err);
      throw invalid(workflowId, `node "${node.id}": ${message}`);
    }
  });
  return { ...node, edges };
}

function validateStructure(wf: WorkflowDefinition, opts: ParseWorkflowOptions): void {
  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) throw invalid(wf.id, `duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  if (!ids.has(wf.entry)) throw invalid(wf.id, `entry node "${wf.entry}" does not exist`);
  if (!wf.nodes.some((n) => n.type === "terminal")) throw invalid(wf.id, "workflow has no terminal node");

  for (const n of wf.nodes) {
    if (n.type === "terminal") continue;
    if (n.type === "parallel") {
      validateParallel(wf, n, ids);
      continue;
    }
    if (!n.edges.length) throw invalid(wf.id, `node "${n.id}" has no outgoing edge`);
    for (const e of n.edges) {
      if (!ids.has(e.to)) throw invalid(wf.id, `node "${n.id}" points at unknown node "${e.to}"`);
      for (const path of e.condition ? conditionPaths(e.condition) : []) {
        if (path[0] === "outputs" && path[1] && !ids.has(path[1])) {
          throw invalid(wf.id, `node "${n.id}" condition reads unknown node output "${path[1]}"`);
        }
        if (path[0] !== "outputs" && path[0] !== "input") {
          throw invalid(wf.id, `node "${n.id}" condition reads "${path[0]}"; only "outputs" and "input" are available`);
        }
      }
    }
    if (n.type === "condition" && !n.edges.some((e) => e.condition)) {
      throw invalid(wf.id, `condition node "${n.id}" has no conditional edge`);
    }
    if (n.edges.filter((e) => !e.condition).length > 1) {
      throw invalid(wf.id, `node "${n.id}" has more than one fallback edge`);
    }
    if (n.type === "agent" && opts.agentExists && !opts.agentExists(n.agent)) {
      throw invalid(wf.id, `node "${n.id}" references unknown agent "${n.agent}"`);
    }
  }

  const reachable = new Set<string>([wf.entry]);
  const queue = [wf.entry];
  while (queue.length) {
    const id = queue.shift()!;
    const cur = wf.nodes.find((n) => n.id === id);
    for (const to of cur ? successorsOf(cur) : []) {
      if (!reachable.has(to)) {
        reachable.add(to);
        queue.push(to);
      }
    }
  }
  const orphans = wf.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
  if (orphans.length) throw invalid(wf.id, `unreachable node${orphans.length > 1 ? "s" : ""}: ${orphans.join(", ")}`);
}

/**
 * A parallel node fans out to branches that must meet again at its join node.
 * The branches are checked here to be genuinely independent regions — disjoint,
 * self-contained, and enterable only through the parallel node — so the engine
 * can run them concurrently without two branches writing the same output or a
 * jump landing in the middle of one.
 */
function validateParallel(wf: WorkflowDefinition, node: Extract<WorkflowNode, { type: "parallel" }>, ids: Set<string>): void {
  const at = `parallel node "${node.id}"`;
  if (!ids.has(node.join)) throw invalid(wf.id, `${at} joins at unknown node "${node.join}"`);
  if (node.join === node.id) throw invalid(wf.id, `${at} cannot join at itself`);
  if (new Set(node.branches).size !== node.branches.length) throw invalid(wf.id, `${at} lists the same branch twice`);

  const regions = new Map<string, Set<string>>();
  for (const branch of node.branches) {
    if (!ids.has(branch)) throw invalid(wf.id, `${at} starts unknown branch "${branch}"`);
    if (branch === node.join) throw invalid(wf.id, `${at} uses its join node "${branch}" as a branch`);
    if (branch === node.id) throw invalid(wf.id, `${at} lists itself as a branch`);
    regions.set(branch, regionOf(wf, branch, node.join));
  }

  const owned = new Map<string, string>();
  for (const [branch, region] of regions) {
    for (const id of region) {
      const other = owned.get(id);
      if (other) throw invalid(wf.id, `${at}: branches "${other}" and "${branch}" both contain node "${id}"`);
      owned.set(id, branch);
    }
  }
  if (owned.has(node.id)) throw invalid(wf.id, `${at} is reachable from inside its own branches`);

  for (const [branch, region] of regions) {
    let reachesJoin = false;
    for (const id of region) {
      const cur = wf.nodes.find((n) => n.id === id)!;
      if (cur.type === "terminal") {
        throw invalid(wf.id, `${at}: branch "${branch}" ends the workflow at "${id}"; a branch must reach the join node "${node.join}"`);
      }
      // A region is a reachability closure, so anything a branch can reach is
      // already inside it; what has to be checked is that it also reaches the
      // join, and (below) that the region belongs to this branch alone.
      if (successorsOf(cur).includes(node.join)) reachesJoin = true;
    }
    if (!reachesJoin) throw invalid(wf.id, `${at}: branch "${branch}" never reaches the join node "${node.join}"`);
  }

  // Nothing outside may jump into a branch: the whole point of a region is that
  // it only ever runs as part of this fan-out.
  for (const other of wf.nodes) {
    if (other.id === node.id || owned.has(other.id)) continue;
    for (const to of successorsOf(other)) {
      const branch = owned.get(to);
      if (branch) {
        throw invalid(wf.id, `node "${other.id}" points into branch "${branch}" of ${at}; a branch is entered only through "${node.id}"`);
      }
    }
  }
}

/** Nodes reachable from `start` without passing through `stop`. */
function regionOf(wf: WorkflowDefinition, start: string, stop: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    const cur = wf.nodes.find((n) => n.id === id);
    for (const to of cur ? successorsOf(cur) : []) {
      if (to === stop || seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}
