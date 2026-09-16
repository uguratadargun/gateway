import { describe, expect, it } from "vitest";

import { release } from "../scripts/changelog-release.mjs";

const LOG = `# Changelog

## Unreleased

- Every repository keeps its record under docs/.
- The recorder reads it from the diff.

## 0.37.0 — 2026-09-15

Publication targets, pinned run definitions and \`gate ask\`.

- feat(ask): one team asks another
`;

describe("cutting a release in the changelog", () => {
  it("moves Unreleased under the new version and leaves Unreleased empty at the top", () => {
    const out = release(LOG, "0.38.0", "2026-09-20") as string;
    expect(out).toBe(`# Changelog

## Unreleased

## 0.38.0 — 2026-09-20

- Every repository keeps its record under docs/.
- The recorder reads it from the diff.

## 0.37.0 — 2026-09-15

Publication targets, pinned run definitions and \`gate ask\`.

- feat(ask): one team asks another
`);
    // Cutting again straight away is refused: Unreleased is empty now.
    expect(() => release(out, "0.38.1", "2026-09-21")).toThrow(/nothing under/);
  });

  it("refuses a version that already has a heading, a bad version, and a log with no Unreleased", () => {
    expect(() => release(LOG, "0.37.0", "2026-09-20")).toThrow(/already has a heading for 0\.37\.0/);
    expect(() => release(LOG, "v0.38", "2026-09-20")).toThrow(/not a version/);
    expect(() => release(LOG, "0.38.0", "20-09-2026")).toThrow(/not a date/);
    expect(() => release("# Changelog\n\n## 0.1.0 — 2026-01-01\n\n- x\n", "0.2.0", "2026-01-02")).toThrow(/no `## Unreleased`/);
  });

  it("works when Unreleased is the only section", () => {
    const out = release("# Changelog\n\n## Unreleased\n\n- first\n", "0.1.0", "2026-01-01") as string;
    expect(out).toBe("# Changelog\n\n## Unreleased\n\n## 0.1.0 — 2026-01-01\n\n- first\n\n");
  });
});
