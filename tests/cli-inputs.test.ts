import { describe, expect, it } from "vitest";

import { parseArgs, parseInputs } from "@/client/cli";

/**
 * `--input` reaches `parseInputs` in two shapes, and both are in use: a person
 * repeats the flag, /gate:run groups the pairs into one quoted value. Splitting
 * on only one of the two separators folds every extra pair into the first
 * value and loses the rest without a word — which is what shipped twice, once
 * in each direction.
 */

function inputsOf(argv: string[]): Record<string, unknown> {
  const args = parseArgs(argv);
  return parseInputs(args.flags, args.positional.slice(1));
}

describe("--input", () => {
  it("collects a repeated flag", () => {
    expect(inputsOf(["run", "smoke", "--input", "a=1", "--input", "b=2"])).toEqual({ a: "1", b: "2" });
  });

  it("splits a grouped value", () => {
    expect(inputsOf(["run", "smoke", "--input", "a=1 b=2"])).toEqual({ a: "1", b: "2" });
  });

  it("takes the two mixed", () => {
    expect(inputsOf(["run", "smoke", "--input", "a=1 b=2", "--input", "c=3"])).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("reads the --input=value form the same way", () => {
    expect(inputsOf(["run", "smoke", "--input=a=1", "--input=b=2"])).toEqual({ a: "1", b: "2" });
  });

  it("ignores repeated separators rather than failing on an empty pair", () => {
    expect(inputsOf(["run", "smoke", "--input", "a=1  b=2 "])).toEqual({ a: "1", b: "2" });
  });

  it("keeps every = after the first inside the value", () => {
    expect(inputsOf(["run", "smoke", "--input", "filter=kind==bug"])).toEqual({ filter: "kind==bug" });
  });

  it("leaves the trailing words as the task", () => {
    expect(inputsOf(["run", "smoke", "--input", "a=1", "fix", "the", "parser"])).toEqual({ a: "1", task: "fix the parser" });
  });

  it("does not let the task overwrite an explicit one", () => {
    expect(inputsOf(["run", "smoke", "--input", "task=given", "typed"])).toEqual({ task: "given" });
  });
});

describe("parseArgs", () => {
  it("joins repeated collectable flags on a NUL", () => {
    expect(parseArgs(["memory", "search", "--path", "src/a", "--path", "src/b"]).flags.path).toBe(["src/a", "src/b"].join("\u0000"));
  });

  it("lets a non-collectable flag's last value win", () => {
    expect(parseArgs(["status", "--limit", "5", "--limit", "9"]).flags.limit).toBe("9");
  });

  it("does not swallow a positional task as a boolean flag's value", () => {
    const args = parseArgs(["run", "smoke", "--yes", "make", "a", "file"]);
    expect(args.flags.yes).toBe(true);
    expect(args.positional).toEqual(["smoke", "make", "a", "file"]);
  });
});
