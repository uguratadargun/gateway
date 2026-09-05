"use client";

import { CornerDownLeft } from "lucide-react";

import type { ApiWorkflowNode } from "@/components/workflow-graph";
import { decisionPoints, loopLinkKeys, type RoutingLink } from "@/workflows/routing";

/**
 * The routing table in words: every point where the run can go more than one
 * way, and where each way leads. This is the orchestrator's whole decision
 * procedure — the engine takes the first edge whose condition holds — so it is
 * worth showing next to the canvas rather than leaving it in the YAML.
 */

function reason(link: RoutingLink): string {
  switch (link.kind) {
    case "branch":
      return "runs together with the other branches";
    case "join":
      return "continues here once every branch has finished";
    case "conditional":
      return `if ${link.when}`;
    default:
      return "otherwise";
  }
}

export function RoutingSummary({
  nodes,
  entry,
  onSelect,
}: {
  nodes: ApiWorkflowNode[];
  entry: string;
  onSelect?: (id: string) => void;
}) {
  const points = decisionPoints(nodes);
  const loops = loopLinkKeys(nodes, entry);
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label;

  if (!points.length) {
    return <p className="text-xs text-muted-foreground">This workflow runs straight through — nothing to decide.</p>;
  }

  return (
    <div className="space-y-2">
      {points.map(({ node, links }) => (
        <div key={node.id} className="rounded-md border p-2">
          <button
            type="button"
            className="font-mono text-xs font-medium underline-offset-2 hover:underline"
            onClick={() => onSelect?.(node.id)}
          >
            {node.id}
          </button>
          {labelOf(node.id) && <span className="ml-1.5 text-[11px] text-muted-foreground">{labelOf(node.id)}</span>}
          <ul className="mt-1 space-y-1.5">
            {links.map((l, i) => {
              const loop = loops.has(`${l.from}->${l.to}`);
              return (
                <li key={i} className="text-[11px] leading-snug">
                  <div className="break-words font-mono text-[10px] text-muted-foreground">{reason(l)}</div>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">→</span>
                    <button
                      type="button"
                      className="font-mono underline-offset-2 hover:underline"
                      onClick={() => onSelect?.(l.to)}
                    >
                      {l.to}
                    </button>
                    {l.label && <span className="text-muted-foreground">· {l.label}</span>}
                    {loop && (
                      <span className="flex items-center gap-0.5 text-amber-500" title="hands control back">
                        <CornerDownLeft className="size-3" /> back
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
