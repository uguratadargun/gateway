import { describe, expect, it } from "vitest";

import { formFromAgent, frontmatterFrom, minutesOf, num } from "@/agents/form";
import { parseAgent, serializeAgent } from "@/agents/loader";

/**
 * The editor's form is the only path a saved agent takes now, so what matters
 * is that a file survives a trip through it unchanged. A field the form does
 * not carry is a field that disappears the first time someone presses save.
 */

const meta = { sourcePath: "/tmp/a.md", updatedAt: 0 };

const FULL = `---
name: Ulak Implementer
description: Writes the planned change.
model: opus
effort: high
executor: claude-code
skills:
  - superpowers-brainstorming
inputs:
  - planner.plan
  - tests.ok?
  - visits.implementer
output:
  type: json
  schema:
    summary: string
    notes: string?
timeoutMs: 3600000
maxTokens: 32000
---

Do the work with {{inputs.planner.plan}}.
`;

describe("the agent editor's form", () => {
  it("round-trips a full definition without losing a field", () => {
    const before = parseAgent("impl", FULL, meta);
    const after = parseAgent("impl", serializeAgent(frontmatterFrom(formFromAgent(before)), before.prompt), meta);

    expect(after.name).toBe(before.name);
    expect(after.description).toBe(before.description);
    expect(after.model).toBe("opus");
    expect(after.effort).toBe("high");
    expect(after.executor).toBe("claude-code");
    // Kept for either executor: a skill is how the agent works, not what it
    // may touch, so unlike `tools` it is not dropped when claude-code is on.
    expect(after.skills).toEqual(["superpowers-brainstorming"]);
    expect(after.inputs).toEqual(before.inputs);
    expect(after.output).toEqual(before.output);
    expect(after.timeoutMs).toBe(3_600_000);
    expect(after.maxTokens).toBe(32_000);
    expect(after.prompt).toBe(before.prompt);
  });

  it("leaves out what was never set, rather than writing a hollow key", () => {
    const front = frontmatterFrom(formFromAgent(parseAgent("a", "---\nname: A\n---\nHi.", meta)));

    expect(front.description).toBeUndefined();
    expect(front.effort).toBeUndefined();
    expect(front.timeoutMs).toBeUndefined();
    expect(front.maxTokens).toBeUndefined();
    expect(front.maxToolIterations).toBeUndefined();
    expect(front.skills).toBeUndefined();
    // Written even at its default: it is the field people did not know existed.
    expect(front.executor).toBe("gate");
  });

  it("drops tools when the executor is claude-code, which never receives them", () => {
    const form = formFromAgent(parseAgent("a", "---\nname: A\ntools: [read_file]\n---\nHi.", meta));
    expect(frontmatterFrom(form).tools).toEqual(["read_file"]);
    expect(frontmatterFrom({ ...form, executor: "claude-code" }).tools).toBeUndefined();
  });

  it("ignores a half-typed row instead of writing an empty name", () => {
    const form = formFromAgent(parseAgent("a", "---\nname: A\n---\nHi.", meta));
    const front = frontmatterFrom({
      ...form,
      inputs: ["planner.plan", "  ", ""],
      outputType: "json",
      outputFields: [
        { field: "summary", type: "string", optional: false },
        { field: "", type: "string", optional: false },
        { field: "notes", type: "string", optional: true },
      ],
    });

    expect(front.inputs).toEqual(["planner.plan"]);
    expect(front.output).toEqual({ type: "json", schema: { summary: "string", notes: "string?" } });
  });

  it("reads timeouts in minutes and an emptied box as unset, not as zero", () => {
    // 0 is a real value — "no timeout at all" — and it has to survive a round
    // trip distinct from an empty box, which means "use the default".
    expect(minutesOf("3600000")).toBe("60");
    expect(minutesOf("1800000")).toBe("30");
    expect(minutesOf("")).toBe("");
    expect(num("")).toBeUndefined();
    expect(num("0")).toBe(0);
  });
});
