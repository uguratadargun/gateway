import { describeFeature, describeHistory, describeSearch } from "@/memory/cards";

import { ToolError, type AgentTool } from "./types";

/**
 * The tools that read the team's memory. They need no workspace — a recall
 * node may run before there is a worktree — and they never write: the
 * recorder and the record index are the only things that do.
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
    "Search the team's memory: what past runs decided (why, how, which files), and each repository's own record — design docs, " +
    "decision records and specs as their base branches have them. Reads the whole team tree (sibling teams' repositories included), " +
    "own team and repository first; a path search stays in this repository. Give a query in words, path prefixes, or both; " +
    "narrow with a time. Every hit names its repository, its run and its commits. " +
    "The answer also carries runs of other people in the tree going right now on work with the same words, interfaces the words " +
    "name with who provides and consumes each, and any open cross-team objection touching what you asked about. " +
    "An objection against this team's own decision is a revision request to plan for, not a note.",
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
    "Read one catalogue feature in full: what it is, how each team in the tree built it (summary and pitfalls), each repository's design doc for it " +
    "with the interfaces it provides and consumes, and every decision filed under it. " +
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

const memoryHistory: AgentTool = {
  name: "memory_history",
  description:
    "What changed under some paths on this repository's base branch, newest first: every commit — gate's or a person's — with " +
    "the record it names on its Documents: line and the gate run it came from. The list to read when something that used to work " +
    "does not: narrow it with since, then read the commits' records and diffs.",
  mutates: false,
  workspaceFree: true,
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Repository path prefixes, e.g. [\"src/sync\"]. Empty means the whole repository." },
      since: { type: "string", description: "Only commits from this time on: \"30d\", \"6 months\", or a date." },
      limit: { type: "integer", description: "How many commits at most (default 30, max 200)." },
    },
  },
  async execute(input, ctx) {
    if (!ctx.memory) throw new ToolError("memory is not reachable from this run");
    const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string" && !!p.trim()) : [];
    const result = await ctx.memory.history({
      paths,
      since: parseSince(input.since) ?? undefined,
      limit: typeof input.limit === "number" ? input.limit : undefined,
    });
    return describeHistory(result);
  },
};

export const MEMORY_TOOLS: AgentTool[] = [memorySearch, memoryFeature, memoryHistory];
