import { dump } from "js-yaml";
import { z } from "zod";

/**
 * Turning a graph back into a workflow file. The visual editor sends the graph
 * it is holding, this writes the canonical YAML for it, and `parseWorkflow`
 * still has the last word — nothing here validates, so a bad graph fails with
 * the same message a hand-edited file would produce.
 *
 * The doc schema is deliberately lenient (unknown keys are dropped rather than
 * rejected) so the editor can post back the nodes exactly as the API handed
 * them over, resolved `condition` trees and all.
 */

const edgeDoc = z
  .object({
    to: z.string(),
    when: z.string().optional(),
    label: z.string().optional(),
  })
  .passthrough()
  .transform((e) => ({ to: e.to, when: e.when, label: e.label }));

const nodeDoc = z.object({
  id: z.string(),
  type: z.enum(["agent", "command", "condition", "parallel", "terminal"]),
  label: z.string().optional(),
  agent: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  command: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
  branches: z.array(z.string()).optional(),
  join: z.string().optional(),
  status: z.enum(["completed", "failed"]).optional(),
  next: z.string().optional(),
  edges: z.array(edgeDoc).optional(),
});

export const workflowGraphDocSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  entry: z.string().min(1),
  workspace: z
    .object({ repo: z.string().optional(), baseRef: z.string().optional(), branchPrefix: z.string().optional() })
    .optional(),
  maxWorkflowSteps: z.number().optional(),
  maxVisits: z.number().optional(),
  nodes: z.array(nodeDoc).min(1),
});

export type WorkflowGraphDoc = z.infer<typeof workflowGraphDocSchema>;
type NodeDoc = z.infer<typeof nodeDoc>;

/** Skips blanks, so an editor field the user cleared disappears from the file. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value) && value.length === 0) return;
  target[key] = value;
}

function trimmedList(values: string[] | undefined): string[] | undefined {
  const out = values?.map((v) => v.trim()).filter(Boolean);
  return out?.length ? out : undefined;
}

function serializeNode(node: NodeDoc): Record<string, unknown> {
  const out: Record<string, unknown> = { id: node.id.trim(), type: node.type };
  put(out, "label", node.label?.trim());

  switch (node.type) {
    case "agent":
      put(out, "agent", node.agent?.trim());
      put(out, "inputs", trimmedList(node.inputs));
      break;
    case "command":
      put(out, "command", trimmedList(node.command));
      put(out, "cwd", node.cwd?.trim());
      put(out, "timeoutMs", node.timeoutMs);
      break;
    case "parallel":
      put(out, "branches", trimmedList(node.branches));
      put(out, "join", node.join?.trim());
      return out;
    case "terminal":
      out.status = node.status ?? "completed";
      return out;
    case "condition":
      break;
  }

  const edges = (node.edges ?? []).filter((e) => e.to.trim());
  if (node.next?.trim() && !edges.length) {
    out.next = node.next.trim();
    return out;
  }
  // One plain edge reads better as `next:`, which is what a hand-written file
  // would say; anything conditional or labelled keeps the full form.
  if (edges.length === 1 && !edges[0].when?.trim() && !edges[0].label?.trim()) {
    out.next = edges[0].to.trim();
    return out;
  }
  put(
    out,
    "edges",
    edges.map((e) => {
      const edge: Record<string, unknown> = {};
      put(edge, "when", e.when?.trim());
      edge.to = e.to.trim();
      put(edge, "label", e.label?.trim());
      return edge;
    }),
  );
  return out;
}

/** Canonical YAML for a graph. Key order matches the hand-written samples. */
export function toWorkflowYaml(doc: WorkflowGraphDoc): string {
  const root: Record<string, unknown> = {};
  root.name = doc.name.trim();
  put(root, "description", doc.description?.trim());
  root.entry = doc.entry.trim();
  // Kept even when empty: `workspace: {}` is what says "this pipeline works in
  // a repository", with the repository itself coming from the run.
  if (doc.workspace) {
    const ws: Record<string, unknown> = {};
    put(ws, "repo", doc.workspace.repo?.trim());
    put(ws, "baseRef", doc.workspace.baseRef?.trim());
    put(ws, "branchPrefix", doc.workspace.branchPrefix?.trim());
    root.workspace = ws;
  }
  put(root, "maxWorkflowSteps", doc.maxWorkflowSteps);
  put(root, "maxVisits", doc.maxVisits);
  root.nodes = doc.nodes.map(serializeNode);
  return dump(root, { lineWidth: 120, noRefs: true });
}
