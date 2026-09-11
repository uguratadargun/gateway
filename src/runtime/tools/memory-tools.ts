import { describeFeature, describeSearch } from "@/memory/cards";

import { ToolError, type AgentTool } from "./types";

/**
 * The two tools that read the team's memory. They need no workspace — a
 * recall node may run before there is a worktree — and they never write: the
 * recorder is the only thing that does, after a run.
 */

/** "30d", "6 months", "2026-05-01" → a moment; null when it is not a time. */
export function parseSince(v: unknown, now = Date.now()): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().toLowerCase();
  const rel = s.match(/^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0];
    const days = unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
    return now - days * 86_400_000;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const memorySearch: AgentTool = {
  name: "memory_search",
  description:
    "Search the team's memory of past runs: what was decided, why and how, and which files or areas each decision touched. " +
    "Reads the whole team tree (sibling teams included), own team first. Give a query in words, path prefixes, or both; " +
    "narrow with a time. Every hit names the run and the commits it came from.",
  mutates: false,
  workspaceFree: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to match: the feature, the problem, the component. Optional if paths are given." },
      paths: { type: "array", items: { type: "string" }, description: "Repository path prefixes a decision must have touched, e.g. [\"src/sync\"]." },
      feature: { type: "string", description: "Only decisions filed under this catalogue feature id." },
      since: { type: "string", description: "Only decisions from this time on: \"30d\", \"6 months\", or a date." },
      as_of: { type: "string", description: "Only decisions that held at this date — what was believed then." },
      limit: { type: "integer", description: "How many decisions at most (default 10, max 50)." },
    },
  },
  async execute(input, ctx) {
    if (!ctx.memory) throw new ToolError("memory is not reachable from this run");
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string" && !!p.trim()) : [];
    const feature = typeof input.feature === "string" && input.feature.trim() ? input.feature.trim() : undefined;
    if (!query && !paths.length && !feature) throw new ToolError("give a query, paths, or a feature");
    const result = await ctx.memory.search({
      query: query || undefined,
      paths: paths.length ? paths : undefined,
      featureId: feature,
      since: parseSince(input.since) ?? undefined,
      asOf: parseSince(input.as_of) ?? undefined,
      limit: typeof input.limit === "number" ? input.limit : undefined,
    });
    return describeSearch(result);
  },
};

const memoryFeature: AgentTool = {
  name: "memory_feature",
  description:
    "Read one catalogue feature in full: what it is, how each team in the tree built it (summary and pitfalls), and every decision filed under it. " +
    "Use it after memory_search names a feature, before planning the same thing on another platform.",
  mutates: false,
  workspaceFree: true,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The feature id, as memory_search printed it." } },
    required: ["id"],
  },
  async execute(input, ctx) {
    if (!ctx.memory) throw new ToolError("memory is not reachable from this run");
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!id) throw new ToolError('"id" is required');
    const detail = await ctx.memory.feature(id);
    if (!detail) return `No feature "${id}" in this team's catalogue.`;
    return describeFeature(detail);
  },
};

export const MEMORY_TOOLS: AgentTool[] = [memorySearch, memoryFeature];
