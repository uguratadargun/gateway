/**
 * Reading a graph the way the engine reads it: where each node can hand control
 * next, which of those links go backwards, and what a given transition was.
 *
 * This is presentation-side knowledge — the UI uses it to show *why* a run went
 * where it went — so it stays free of node builtins and works on the plain node
 * shape the API returns.
 */

export interface RoutingEdge {
  to: string;
  label?: string;
  when?: string;
}

export interface RoutingNode {
  id: string;
  type: string;
  status?: string;
  edges?: RoutingEdge[];
  branches?: string[];
  join?: string;
}

export type LinkKind = "conditional" | "fallback" | "branch" | "join";

export interface RoutingLink {
  from: string;
  to: string;
  label?: string;
  when?: string;
  kind: LinkKind;
}

/** Every link out of a node, including the ones a parallel node routes through. */
export function outgoingLinks(node: RoutingNode): RoutingLink[] {
  if (node.type === "parallel") {
    const branches = (node.branches ?? []).map<RoutingLink>((to) => ({ from: node.id, to, kind: "branch" }));
    return node.join ? [...branches, { from: node.id, to: node.join, kind: "join" }] : branches;
  }
  return (node.edges ?? []).map<RoutingLink>((e) => ({
    from: node.id,
    to: e.to,
    label: e.label,
    when: e.when,
    kind: e.when ? "conditional" : "fallback",
  }));
}

export function incomingLinks(nodes: RoutingNode[], id: string): RoutingLink[] {
  return nodes.flatMap((n) => outgoingLinks(n).filter((l) => l.to === id));
}

/**
 * Links that hand control back into a node the run is still inside — the
 * "tests failed, implement again" edges. These are the back edges of a depth
 * first walk from the entry: an edge whose target is still open on the walk's
 * stack closes a cycle, while an edge into something already finished (a
 * parallel branch meeting its join, say) merely rejoins the flow and is not a
 * loop at all.
 */
export function loopLinkKeys(nodes: RoutingNode[], entry: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keys = new Set<string>();
  /** 1 = open on the current path, 2 = fully explored. */
  const state = new Map<string, 1 | 2>();

  for (const root of [entry, ...nodes.map((n) => n.id)]) {
    const start = byId.get(root);
    if (!start || state.has(root)) continue;
    const stack = [{ id: root, links: outgoingLinks(start), next: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.next >= top.links.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const link = top.links[top.next++];
      const target = byId.get(link.to);
      if (!target) continue;
      const seen = state.get(link.to);
      // Still open: the walk reached a node it is already inside, so this edge
      // sends the run back around. A self-loop lands here too.
      if (seen === 1) keys.add(`${link.from}->${link.to}`);
      if (seen) continue;
      state.set(link.to, 1);
      stack.push({ id: link.to, links: outgoingLinks(target), next: 0 });
    }
  }
  return keys;
}

/**
 * Where the engine actually makes a choice: a node with more than one way out,
 * or with a condition on the only one it has.
 */
export function decisionPoints(nodes: RoutingNode[]): Array<{ node: RoutingNode; links: RoutingLink[] }> {
  return nodes
    .map((node) => ({ node, links: outgoingLinks(node) }))
    .filter(({ node, links }) => node.type === "parallel" || links.length > 1 || links.some((l) => l.when));
}

/**
 * The link a run took between two steps. `null` when the definition offers more
 * than one way to get there: the step history alone cannot say which, and
 * guessing would put a wrong reason next to a real run.
 */
export function linkBetween(nodes: RoutingNode[], from: string, to: string): RoutingLink | null {
  const node = nodes.find((n) => n.id === from);
  if (!node) return null;
  const matches = outgoingLinks(node).filter((l) => l.to === to);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Which link each step of a finished run took, read back from the sequence of
 * nodes it visited. A parallel node hands control to all of its branches at
 * once, so a run's step order interleaves them: the link out of a step is found
 * by looking forward for the first step that is actually one of its
 * successors, not by pairing neighbours.
 *
 * A terminal node never runs, so the last decision of a finished run has no
 * step to point at; `endedWith` recovers it from the run's outcome, but only
 * where a single terminal could have produced it.
 */
export function takenLinks(
  nodes: RoutingNode[],
  sequence: string[],
  endedWith?: "completed" | "failed",
): RoutingLink[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return sequence.map((id, i) => {
    const node = byId.get(id);
    if (!node) return [];
    const links = outgoingLinks(node);
    const rest = sequence.slice(i + 1);
    if (node.type === "parallel") return links.filter((l) => rest.includes(l.to));
    const targets = new Set(links.map((l) => l.to));
    const next = rest.find((step) => targets.has(step));
    if (next) return links.filter((l) => l.to === next);
    if (endedWith && i === sequence.length - 1) {
      const ends = links.filter((l) => {
        const target = byId.get(l.to);
        return target?.type === "terminal" && (target.status ?? "completed") === endedWith;
      });
      if (ends.length === 1) return ends;
    }
    return [];
  });
}
