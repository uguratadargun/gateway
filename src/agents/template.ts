/**
 * Prompt templating for agent definitions.
 *
 * Supports one construct — `{{ some.dotted.path }}` — resolved against an
 * explicit context object. Substitution is regex-based with no expression
 * evaluation, so an agent file cannot run code.
 */

export class TemplateError extends Error {}

// Segments may contain dashes, because node ids do: an unmatched placeholder
// would otherwise be neither validated nor substituted, and reach the model raw.
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)\s*\}\}/g;

/** Every path a template references, for load-time dependency checking. */
export function templatePaths(tpl: string): string[] {
  const out = new Set<string>();
  for (const m of tpl.matchAll(PLACEHOLDER)) out.add(m[1]);
  return [...out];
}

function lookup(path: string, ctx: Record<string, unknown>): unknown {
  let cur: unknown = ctx;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}

/**
 * Render `tpl` against `ctx`. An unresolved placeholder throws: a node only
 * ever sees inputs it declared, so a missing one is an authoring error that
 * should surface before the request is sent, not a silently empty prompt.
 */
export function renderTemplate(tpl: string, ctx: Record<string, unknown>): string {
  const missing: string[] = [];
  const out = tpl.replace(PLACEHOLDER, (_m, path: string) => {
    const v = lookup(path, ctx);
    if (v === undefined) {
      missing.push(path);
      return "";
    }
    return stringify(v);
  });
  if (missing.length) throw new TemplateError(`unresolved template ${missing.length > 1 ? "values" : "value"}: ${missing.join(", ")}`);
  return out;
}
