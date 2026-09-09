import { describe, expect, it } from "vitest";

import { describeCall, describeText } from "@/client/worker-log";

/**
 * The worker's log is what the person sees of a node that runs out of sight,
 * so it has to read like the work: the file, the change, the command.
 */
const ROOT = "/Users/me/.gate/workspaces/e1";
const at = Date.parse("2026-09-09T12:00:00Z");

function call(tool: string, input: unknown, result = "", ok = true) {
  return { tool, input, ok, result, startedAt: at, durationMs: 1 };
}

describe("a tool call in the worker's log", () => {
  it("names the file a read touched, relative to the worktree", () => {
    const line = describeCall(call("Read", { file_path: `${ROOT}/src/a.ts` }, "     1\timport x"), ROOT);
    expect(line).toBe("12:00:00   Read src/a.ts → 1\timport x\n");
  });

  it("shows an edit as the change it made", () => {
    const line = describeCall(
      call("Edit", { file_path: `${ROOT}/src/a.ts`, old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" }, "updated"),
      ROOT,
    );
    expect(line.split("\n")).toEqual([
      "12:00:00   Edit src/a.ts",
      "           - const a = 1;",
      "           + const a = 2;",
      "           + const b = 3;",
      "",
    ]);
  });

  it("folds a long edit rather than flooding the terminal", () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const line = describeCall(call("Edit", { file_path: "x.ts", old_string: "", new_string: many }), ROOT);
    expect(line).toContain("+ line 11");
    expect(line).not.toContain("+ line 12\n");
    expect(line).toContain("+ … 28 more lines");
  });

  it("shows the command a shell call ran and the first line back", () => {
    const line = describeCall(call("Bash", { command: "pnpm test", description: "Run tests" }, "\n 42 passed\n"), ROOT);
    expect(line).toBe("12:00:00   $ pnpm test → 42 passed\n");
  });

  it("marks a refused call and keeps its reason", () => {
    const line = describeCall(call("Edit", { file_path: "x.ts", old_string: "a", new_string: "b" }, "denied", false), ROOT);
    expect(line).toBe("12:00:00 ✗ Edit x.ts → denied\n");
  });

  it("counts what a write produced instead of printing it", () => {
    const line = describeCall(call("Write", { file_path: `${ROOT}/docs/plan.md`, content: "a\nb\nc" }, "ok"), ROOT);
    expect(line).toBe("12:00:00   Write docs/plan.md (3 lines)\n");
  });

  it("names a subagent by what it was asked to do", () => {
    const line = describeCall(call("Task", { description: "Implement task 2", subagent_type: "general-purpose", prompt: "…" }, "done"), ROOT);
    expect(line).toBe('12:00:00   Agent (general-purpose) "Implement task 2" → done\n');
  });

  it("falls back to the input for a tool it does not know", () => {
    const line = describeCall(call("mcp__x__y", { q: 1 }, "r"), ROOT);
    expect(line).toBe('12:00:00   mcp__x__y {"q":1} → r\n');
  });
});

describe("what the agent says between calls", () => {
  it("is kept, marked, and folded past a few lines", () => {
    expect(describeText("  \n", at)).toBe("");
    expect(describeText("Starting with the tests.\n\nThen the handler.", at)).toBe(
      "12:00:00 » Starting with the tests.\n           » Then the handler.\n",
    );
    const long = Array.from({ length: 10 }, (_, i) => `p${i}`).join("\n");
    expect(describeText(long, at)).toContain("» … 4 more lines");
  });
});
