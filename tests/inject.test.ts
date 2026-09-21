import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { syncSubagents } from "@/client/subagents";
import { backgroundSubagentNotice, fileReadingNotice, unattendedNotice } from "@/skills/inject";

/**
 * The notices are issued in exactly two places, and both get all of them.
 *
 * Until now that was a doc-comment in `src/skills/inject.ts` and nothing else,
 * so the way it broke was always the same: a notice added where it was needed
 * — the executor, because that is the site somebody was looking at — and not
 * at the other, which leaves a subagent of the person's own session without
 * it. A subagent is the site that matters most, because it is the one a
 * person is watching, and the one that gets no appended system prompt.
 *
 * The executor's half is pinned in `claude-code.test.ts`, where the spawn
 * arguments are already read. This is the other half, plus the invariant
 * itself: whatever the set of notices is, the mirror carries all of it.
 */

const NOTICES = { unattended: unattendedNotice, background: backgroundSubagentNotice, files: fileReadingNotice };

const previousHome = process.env.GATE_HOME;
const previousConfig = process.env.CLAUDE_CONFIG_DIR;
let home: string;
let scope: { root: string; teamId: string };

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gate-inject-"));
  process.env.GATE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "gate-inject-claude-"));
  const root = join(home, "cache", "t");
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(
    join(root, "agents", "builder.md"),
    `---
name: Builder
model: sonnet
executor: claude-code
inputs: []
output:
  type: json
  schema:
    summary: string
---

Build the thing.
`,
  );
  scope = { root, teamId: "t" };
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.GATE_HOME;
  else process.env.GATE_HOME = previousHome;
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfig;
});

describe("the notices a claude-code node is given", () => {
  it("all reach the subagent mirror, which is the site with no appended system prompt", () => {
    expect(syncSubagents("t", scope).written).toEqual(["gate-t-builder"]);
    const file = readFileSync(join(process.env.CLAUDE_CONFIG_DIR as string, "agents", "gate-t-builder.md"), "utf8");
    // The mirror is not given the unattended notice: the delegate instruction
    // carries that one per node, because a `gate` node run by the session is
    // attended and the same file would be wrong for it. Everything that is
    // true of a subagent whatever the node is, is here.
    for (const [name, notice] of Object.entries(NOTICES)) {
      if (name === "unattended") continue;
      expect(file, `${name} notice missing from the subagent mirror`).toContain(notice());
    }
  });

  it("says what each one was written against, so a later edit knows what it would undo", () => {
    // Each of these is a measured failure, named in the doc-comment above the
    // function it belongs to. A rewrite that drops the sentence drops the fix.
    const background = backgroundSubagentNotice();
    // Eighty sleeps in one node, and fifteen of one node's twenty-four shell
    // calls being `true`, `sleep`, `echo` or `date`: the ban is on the purpose.
    expect(background).toContain("only purpose is to let time pass");
    // Four fork dispatches became sixteen, because the copied context held the
    // instruction to fan out.
    expect(background).toContain("copies your own context");
    // A 425.9-second result that finished and was never read, under a verdict
    // that shipped anyway.
    expect(background).toContain("you have no final answer yet");
    // Forty-three Reads for a second against a hundred and seven shell calls
    // for nearly four minutes, and thirteen Edits refused for a `cat`.
    const files = fileReadingNotice();
    expect(files).toContain("Read files with Read");
    expect(files).toContain("File has not been read yet");
  });
});
