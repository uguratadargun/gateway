import { describe, expect, it } from "vitest";

import { describeCall, describeText } from "@/client/worker-log";

/**
 * The worker's log is what the person sees of a node that runs out of sight,
 * so it reads the way Claude Code shows the same activity: one short line each.
 */
const ROOT = "/Users/me/.gate/workspaces/e1";

function call(tool: string, input: unknown, result = "", ok = true) {
  return { tool, input, ok, result, startedAt: 0, durationMs: 1 };
}

describe("a tool call in the worker's log", () => {
  it("names the file a read touched, relative to the worktree, and nothing of its content", () => {
    expect(describeCall(call("Read", { file_path: `${ROOT}/src/a.ts` }, "     1\timport x"), ROOT)).toBe("⏺ Read src/a.ts\n");
  });

  it("shows an edit by its size, not its diff", () => {
    const line = describeCall(
      call("Edit", { file_path: `${ROOT}/src/a.ts`, old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" }, "updated"),
      ROOT,
    );
    expect(line).toBe("⏺ Edit src/a.ts (+2 −1)\n");
  });

  it("shows a shell call by what it was for", () => {
    expect(describeCall(call("Bash", { command: "pnpm test", description: "Run tests" }, "\n 42 passed\n"), ROOT)).toBe("⏺ Bash: Run tests\n");
    expect(describeCall(call("Bash", { command: "git status" }, ""), ROOT)).toBe("⏺ Bash: git status\n");
  });

  it("keeps the reason when a call was refused", () => {
    expect(describeCall(call("Edit", { file_path: "x.ts", old_string: "a", new_string: "b" }, "denied", false), ROOT)).toBe(
      "⏺ Edit x.ts (+1 −1) — denied\n",
    );
  });

  it("counts what a write produced", () => {
    expect(describeCall(call("Write", { file_path: `${ROOT}/docs/plan.md`, content: "a\nb\nc" }, "ok"), ROOT)).toBe(
      "⏺ Write docs/plan.md (3 lines)\n",
    );
  });

  it("names a subagent by what it was asked to do", () => {
    expect(describeCall(call("Task", { description: "Implement task 2", subagent_type: "general-purpose", prompt: "…" }, "done"), ROOT)).toBe(
      "⏺ Agent: Implement task 2\n",
    );
  });

  it("names a tool it does not know, without its input", () => {
    expect(describeCall(call("mcp__x__y", { q: 1 }, "r"), ROOT)).toBe("⏺ mcp__x__y\n");
  });
});

describe("what the agent says between calls", () => {
  it("is kept short", () => {
    expect(describeText("  \n")).toBe("");
    expect(describeText("Starting with the tests.\n\nThen the handler.")).toBe("⏺ Starting with the tests.\n  Then the handler.\n");
    expect(describeText("a\nb\nc\nd\ne")).toBe("⏺ a\n  b\n  c\n  …\n");
  });
});
