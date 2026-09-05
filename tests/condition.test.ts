import { describe, expect, it } from "vitest";

import { ConditionError, conditionPaths, evaluateCondition, parseCondition } from "@/workflows/condition";

const ctx = {
  outputs: {
    tester: { passed: false, failures: 3 },
    reviewer: { verdict: "changes_requested", score: 7.5 },
  },
};

describe("evaluateCondition", () => {
  it("compares dotted paths against literals", () => {
    expect(evaluateCondition("outputs.tester.passed == false", ctx)).toBe(true);
    expect(evaluateCondition("outputs.tester.passed == true", ctx)).toBe(false);
    expect(evaluateCondition('outputs.reviewer.verdict == "changes_requested"', ctx)).toBe(true);
    expect(evaluateCondition("outputs.tester.failures > 0", ctx)).toBe(true);
    expect(evaluateCondition("outputs.reviewer.score >= 7.5", ctx)).toBe(true);
  });

  it("combines with && || ! and parentheses", () => {
    expect(evaluateCondition('outputs.tester.passed == false && outputs.reviewer.verdict != "approved"', ctx)).toBe(true);
    expect(evaluateCondition("outputs.tester.passed || outputs.tester.failures == 0", ctx)).toBe(false);
    expect(evaluateCondition("!outputs.tester.passed", ctx)).toBe(true);
    expect(evaluateCondition("(outputs.tester.failures > 5 || outputs.reviewer.score < 8) && !outputs.tester.passed", ctx)).toBe(true);
  });

  it("treats a missing path and an explicit null as absent", () => {
    expect(evaluateCondition("outputs.security.blocking == null", ctx)).toBe(true);
    expect(evaluateCondition("outputs.security.blocking != null", ctx)).toBe(false);
    expect(evaluateCondition("outputs.nope.value == true", ctx)).toBe(false);
  });

  it("never evaluates JavaScript", () => {
    expect(() => evaluateCondition("process.exit(1)", ctx)).toThrow(ConditionError);
    expect(() => evaluateCondition("1; console.log('x')", ctx)).toThrow(ConditionError);
    expect(() => evaluateCondition("outputs.tester.passed = true", ctx)).toThrow(ConditionError);
  });

  it("rejects malformed expressions at parse time", () => {
    expect(() => parseCondition("outputs.tester.passed ==")).toThrow(ConditionError);
    expect(() => parseCondition("(outputs.a == 1")).toThrow(ConditionError);
    expect(() => parseCondition('"unterminated')).toThrow(ConditionError);
    expect(() => parseCondition("")).toThrow(ConditionError);
  });

  it("refuses to compare mismatched types with an ordering operator", () => {
    expect(() => evaluateCondition('outputs.reviewer.verdict > 3', ctx)).toThrow(ConditionError);
  });

  it("reports the paths an expression reads, for load-time validation", () => {
    const ast = parseCondition('outputs.tester.passed == false && outputs.reviewer.verdict != "approved"');
    expect(conditionPaths(ast)).toEqual([
      ["outputs", "tester", "passed"],
      ["outputs", "reviewer", "verdict"],
    ]);
  });
});
