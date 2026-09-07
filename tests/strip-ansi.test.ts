import { describe, expect, it } from "vitest";

import { stripAnsi } from "@/lib/utils";

const ESC = "";

describe("stripAnsi", () => {
  it("removes the colour codes a test runner emits", () => {
    expect(stripAnsi(`${ESC}[31mFAIL${ESC}[0m tests/a.test.ts`)).toBe("FAIL tests/a.test.ts");
    expect(stripAnsi(`${ESC}[1;32m✓${ESC}[0m ok`)).toBe("✓ ok");
  });

  it("leaves bracketed text that only looks like a colour code alone", () => {
    // The escape byte is the whole difference, and it is invisible in an editor
    // — a copy of this regex that loses it eats real source instead of colour.
    expect(stripAnsi("const a = b[0m];")).toBe("const a = b[0m];");
    expect(stripAnsi("matrix[1;2m] index")).toBe("matrix[1;2m] index");
  });
});
