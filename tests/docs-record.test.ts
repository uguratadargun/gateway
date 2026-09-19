import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkRecord } from "../scripts/check-docs.mjs";

const REPO = resolve(__dirname, "..");

function decision(n: string, title: string, extra: Partial<Record<string, string>> = {}): string {
  const status = extra.status ?? "accepted";
  const sections = ["Context", "Decision", "Rationale", "Alternatives", "How it works", "Consequences", "Touches", "Supersedes"]
    .filter((s) => !(extra.drop === s))
    .map((s) => `## ${s}\n\n${extra[s] ?? (s === "Supersedes" ? "none" : s === "Touches" ? "- src/x.ts" : `Some ${s.toLowerCase()}.`)}\n`)
    .join("\n");
  return `# ${extra.heading ?? n}. ${title}\n\nStatus: ${status}\nDate: 2026-09-19\n\n${sections}`;
}

function design(name: string, decisions: string[], extra: { drop?: string; body?: string } = {}): string {
  const list = decisions.map((d) => `- [${d.slice(0, 4)} — Title](../decisions/${d}.md)`).join("\n") || "- none yet";
  const secs: Array<[string, string]> = [
    ["Summary", `What ${name} does.`],
    ["How it works", extra.body ?? "The flow."],
    ["Key files", "- `src/x.ts` — the thing"],
    ["Pitfalls", "- One trap."],
    ["Decisions", list],
  ];
  return `# ${name}\n\n${secs
    .filter(([s]) => s !== extra.drop)
    .map(([s, b]) => `## ${s}\n\n${b}\n`)
    .join("\n")}`;
}

const spec = (decisions = "none", designLine = "docs/design/sync.md") =>
  `Status: done\nBranch: main\nDecisions: ${decisions}\nDesign: ${designLine}\n\n# The plan\n\n## Goal\n\nA thing.\n`;

/** Writes a record tree under a fresh temp dir; a value of `null` leaves the path out. */
function tree(files: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), "gate-record-"));
  const base: Record<string, string> = {
    "docs/ARCHITECTURE.md": "# map\n",
    "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- x\n",
    "docs/plans/.gitignore": "*\n",
  };
  for (const [rel, body] of Object.entries({ ...base, ...files })) {
    if (body === null) continue;
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  roots.push(root);
  return root;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const VALID: Record<string, string> = {
  "docs/decisions/0001-first.md": decision("0001", "First"),
  "docs/decisions/0002-second.md": decision("0002", "Second", { status: "superseded by 0003" }),
  "docs/decisions/0003-third.md": decision("0003", "Third", { Supersedes: "0002 — the reason moved on." }),
  "docs/design/sync.md": design("Sync", ["0003-third", "0001-first"], { body: "See → `decisions/0001-first.md`." }),
  "docs/specs/2026-09-19-a-topic.md": spec("docs/decisions/0003-third.md — and why"),
};

describe("the repository's own record", () => {
  it("has its form", () => {
    expect(checkRecord(REPO)).toEqual([]);
  });
});

describe("checking a record's form", () => {
  it("passes a record with every form right, wrapped spec headers included", () => {
    const root = tree({
      ...VALID,
      "docs/specs/2026-09-19-wrapped.md":
        "Status: done\nBranch: main\nDecisions: none — nothing recorded covered this,\nthe design doc already said it\nDesign: docs/design/sync.md (the polling\nrules)\nHistory: v2\n\n# Plan\n",
    });
    expect(checkRecord(root)).toEqual([]);
  });

  it("names a decision number used twice, and a gap in the numbers", () => {
    const twice = tree({ ...VALID, "docs/decisions/0003-other.md": decision("0003", "Other") });
    // The record that kept the number is now the one 0002 points at, and it says nothing of 0002.
    expect(checkRecord(twice)).toEqual([
      expect.stringMatching(/0003-third\.md: number 0003 is already taken by docs\/decisions\/0003-other\.md/),
      expect.stringMatching(/0003-other\.md: Supersedes does not name 0002/),
    ]);

    const gap = tree({ ...VALID, "docs/decisions/0005-fifth.md": decision("0005", "Fifth") });
    expect(checkRecord(gap)).toEqual([expect.stringMatching(/docs\/decisions: numbers skip from 0003 to 0005/)]);
  });

  it("holds a decision record to its heading, status, date and eight sections", () => {
    const root = tree({
      ...VALID,
      "docs/decisions/0004-fourth.md": decision("0004", "Fourth", { heading: "0005", status: "draft", drop: "Alternatives", Consequences: "" }).replace("Date: 2026-09-19", "Date: 19.09.2026"),
    });
    const problems = checkRecord(root);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/0004-fourth\.md: heading says 0005, file name says 0004/),
        expect.stringMatching(/0004-fourth\.md: Status is "draft"/),
        expect.stringMatching(/0004-fourth\.md: Date "19\.09\.2026" is not YYYY-MM-DD/),
        expect.stringMatching(/0004-fourth\.md: section `## Alternatives` is missing/),
        expect.stringMatching(/0004-fourth\.md: section `## Consequences` is empty/),
      ]),
    );
    expect(problems.every((p) => p.startsWith("docs/decisions/0004-fourth.md"))).toBe(true);
  });

  it("wants supersession said on both records", () => {
    const oneWay = tree({ ...VALID, "docs/decisions/0003-third.md": decision("0003", "Third") });
    expect(checkRecord(oneWay)).toEqual([expect.stringMatching(/0003-third\.md: Supersedes does not name 0002, whose Status says this record replaced it/)]);

    const dangling = tree({ ...VALID, "docs/decisions/0002-second.md": decision("0002", "Second", { status: "superseded by 0009" }) });
    expect(checkRecord(dangling)).toEqual([expect.stringMatching(/0002-second\.md: Status says superseded by 0009, which does not exist/)]);

    const backwards = tree({ ...VALID, "docs/decisions/0001-first.md": decision("0001", "First", { Supersedes: "0003 — no." }) });
    expect(checkRecord(backwards)).toEqual([expect.stringMatching(/0001-first\.md: Supersedes names 0003, a later or equal number/)]);
  });

  it("holds a design doc to its five sections and its pointers", () => {
    const root = tree({
      ...VALID,
      "docs/design/pool.md": design("Pool", ["0004-nope"], { drop: "Pitfalls", body: "Settled → `decisions/0007-…`." }),
    });
    expect(checkRecord(root)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/pool\.md: section `## Pitfalls` is missing/),
        expect.stringMatching(/pool\.md: links to \.\.\/decisions\/0004-nope\.md, which does not exist/),
        expect.stringMatching(/pool\.md: refers to decision 0007, which does not exist/),
      ]),
    );
  });

  it("holds a spec to its header and the files it names", () => {
    const root = tree({
      ...VALID,
      "docs/specs/2026-09-19-dash.md": spec("—"),
      "docs/specs/2026-09-19-lost.md": spec("none", "docs/design/gone.md"),
      "docs/specs/2026-09-19-short.md": "Status: done\nBranch: main\n\n# Plan\n",
      "docs/specs/19-09-2026-when.md": spec(),
    });
    expect(checkRecord(root)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/dash\.md: `Decisions:` is neither `none` nor a path under docs\//),
        expect.stringMatching(/lost\.md: `Design:` names docs\/design\/gone\.md, which does not exist/),
        expect.stringMatching(/short\.md: header line 3 is not `Decisions:`/),
        expect.stringMatching(/19-09-2026-when\.md: name is not YYYY-MM-DD-<topic>\.md/),
      ]),
    );
  });

  it("wants the map, the changelog's Unreleased section and the ignored plans directory", () => {
    const root = tree({ ...VALID, "docs/ARCHITECTURE.md": null, "CHANGELOG.md": "# Changelog\n\n## 0.1.0 — 2026-01-01\n", "docs/plans/.gitignore": "*.md\n" });
    expect(checkRecord(root)).toEqual([
      expect.stringMatching(/ARCHITECTURE\.md: missing/),
      expect.stringMatching(/CHANGELOG\.md: has no `## Unreleased` section/),
      expect.stringMatching(/plans\/\.gitignore: does not ignore `\*`/),
    ]);
  });
});
