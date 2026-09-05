/**
 * Why a step refused, in the few lines that actually say so.
 *
 * A failing gate hands back a whole test run: install notices, upgrade banners,
 * passing suites, and somewhere in the middle the one assertion that matters.
 * Reading a run meant expanding a step and scrolling through it. This pulls out
 * the lines a person would have gone looking for, so the run can say what
 * happened without being opened.
 *
 * Pure — the execution page renders it in the browser.
 */

// Test runners colour their output; the escape codes are noise here.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Lines that carry the failure, most specific first. */
const SIGNALS: RegExp[] = [
  /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError)\b/,
  /\berror TS\d+\b/,
  /^\s*(?:FAIL|✕|×|✗|✘)\s/u,
  /\b(?:Unable to find|Cannot find|Module not found|not found)\b/,
  /\b(?:Expected|Received|expected .* to)\b/,
  /^\s*(?:Error|error):/,
  /\b\d+ (?:failed|failing)\b/,
];

/** Lines that are never the reason, however loudly they shout. */
const NOISE: RegExp[] = [
  /^\s*[┌│└─╭╰]/u, // boxed update notices
  /npm (?:warn|notice)/i,
  /Update available/i,
  /^\s*$/,
  /^\s*at\s+\S+\s*\(/, // stack frames: the message above them is the point
];

function clean(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() && !NOISE.some((n) => n.test(l)));
}

function pick(lines: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const signal of SIGNALS) {
    for (const line of lines) {
      if (!signal.test(line)) continue;
      const key = line.trim().slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export interface StepFailure {
  /** What refused: a command's exit code, or an agent's verdict. */
  headline: string;
  /** The lines that say why. May be empty when the output says nothing useful. */
  lines: string[];
}

/**
 * Reads a step's output as a refusal. Returns null when the step did not refuse
 * — a passing gate has nothing to explain.
 */
export function stepFailure(output: unknown, limit = 4): StepFailure | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;

  if (o.ok === false) {
    const exit = typeof o.exitCode === "number" ? o.exitCode : null;
    const lines = pick([...clean(o.stderr), ...clean(o.stdout)], limit);
    // Nothing matched a known failure shape: the tail of the output is still
    // better than silence, and it is where runners print their summary.
    const fallback = [...clean(o.stderr), ...clean(o.stdout)].slice(-limit).map((l) => l.trim().slice(0, 200));
    return {
      headline: exit == null ? "command failed" : `exit ${exit}`,
      lines: lines.length ? lines : fallback,
    };
  }

  if (typeof o.verdict === "string" && o.verdict !== "approved") {
    const detail = [o.feedback, o.findings, o.notes].flat().filter((v): v is string => typeof v === "string" && !!v.trim());
    return { headline: o.verdict, lines: detail.slice(0, limit).map((l) => l.trim().slice(0, 200)) };
  }

  if (o.passed === false) {
    const failures = Array.isArray(o.failures) ? o.failures : [];
    const detail = failures.filter((v): v is string => typeof v === "string");
    return {
      headline: "tests failed",
      lines: detail.length ? detail.slice(0, limit) : typeof o.notes === "string" ? [o.notes.slice(0, 200)] : [],
    };
  }

  return null;
}
