import { describe, expect, it } from "vitest";

import { stepFailure } from "@/executions/failure";

/**
 * A failing gate hands back a whole test run. What matters is that the line a
 * person would have gone looking for survives, and the banners do not.
 */

const E = "";

const VITEST_OUTPUT = [
  `${E}[2mLoaded Prisma config from prisma.config.ts.${E}[22m`,
  "┌─────────────────────────────────────────┐",
  "│  Update available 7.8.0 -> 8.0.0-rc.13  │",
  "└─────────────────────────────────────────┘",
  ` ${E}[32mPASS${E}[39m src/live-support/live-support.service.spec.ts (20.74 s)`,
  " FAIL  |web| features/claim-files/wizard/steps.leave-badge.test.tsx > izin rozeti",
  'TestingLibraryElementError: Unable to find an accessible element with the role "option"',
  "    at Object.getElementError (/x/config.js:37:19)",
  " × izindeki kullanıcı için rozet gösterir 506ms",
].join("\n");

describe("step failure", () => {
  it("pulls the failing lines out of a noisy test run", () => {
    const failure = stepFailure({ ok: false, exitCode: 1, stdout: VITEST_OUTPUT, stderr: "" })!;

    expect(failure.headline).toBe("exit 1");
    const joined = failure.lines.join("\n");
    expect(joined).toContain("Unable to find an accessible element");
    expect(joined).toContain("steps.leave-badge.test.tsx");
    // The banners, the passing suite and the stack frames are not the reason.
    expect(joined).not.toContain("Update available");
    expect(joined).not.toContain("PASS");
    expect(joined).not.toContain("at Object.getElementError");
    // Terminal colour codes never reach the reader.
    expect(joined).not.toContain(E);
  });

  it("falls back to the tail when nothing matches a known failure shape", () => {
    const failure = stepFailure({ ok: false, exitCode: 2, stdout: "doing a thing\nit went badly\n", stderr: "" })!;
    expect(failure.lines).toEqual(["doing a thing", "it went badly"]);
  });

  it("reads a review that asked for changes", () => {
    const failure = stepFailure({
      verdict: "changes_requested",
      findings: ["no test covers the new branch"],
      feedback: "split the handler",
    })!;
    expect(failure.headline).toBe("changes_requested");
    expect(failure.lines).toContain("split the handler");
    expect(failure.lines).toContain("no test covers the new branch");
  });

  it("says nothing about a step that did not refuse", () => {
    expect(stepFailure({ ok: true, exitCode: 0, stdout: "all good" })).toBeNull();
    expect(stepFailure({ verdict: "approved" })).toBeNull();
    expect(stepFailure(null)).toBeNull();
    expect(stepFailure("a string")).toBeNull();
  });
});
