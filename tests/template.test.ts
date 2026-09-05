import { describe, expect, it } from "vitest";

import { TemplateError, renderTemplate, templatePaths } from "@/agents/template";

describe("renderTemplate", () => {
  it("substitutes dotted paths and tolerates inner whitespace", () => {
    const out = renderTemplate("Plan:\n{{ inputs.planner.plan }}\nSteps: {{inputs.planner.steps}}", {
      inputs: { planner: { plan: "do the thing", steps: 3 } },
    });
    expect(out).toBe("Plan:\ndo the thing\nSteps: 3");
  });

  it("serializes objects and arrays as JSON", () => {
    const out = renderTemplate("{{inputs.tester.result}}", { inputs: { tester: { result: { passed: false } } } });
    expect(out).toBe('{\n  "passed": false\n}');
  });

  it("throws on an unresolved placeholder instead of rendering an empty prompt", () => {
    expect(() => renderTemplate("{{inputs.missing.value}}", { inputs: {} })).toThrow(TemplateError);
  });

  it("renders explicit null and false rather than treating them as missing", () => {
    expect(renderTemplate("{{a}} {{b}}", { a: null, b: false })).toBe("null false");
  });

  it("lists referenced paths for dependency checking", () => {
    expect(templatePaths("{{inputs.a.b}} {{ inputs.c }} {{inputs.a.b}}")).toEqual(["inputs.a.b", "inputs.c"]);
  });
});
