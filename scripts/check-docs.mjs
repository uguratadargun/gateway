#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks the form of this repository's record — the files under docs/ and
 * CHANGELOG.md that plugins/gate/reference/docs.md describes.
 *
 * Whether a record is *true* is a judgement, and the reviewer's. Whether it
 * has the shape the convention asks for is not: a decision number used twice,
 * a section missing, a link to a file that is not there, a spec whose header
 * names a record that does not exist. Those are facts about the tree, and a
 * script sees them every time where a reader sees them sometimes. This is
 * that script. It reads, it never writes, and it reports every problem it
 * finds rather than the first.
 *
 * `npm run docs:check` runs it; tests/docs-record.test.ts runs the same
 * function inside `npm test`, so a record left in the wrong shape fails the
 * suite the verifier runs.
 */

export const DECISION_SECTIONS = ["Context", "Decision", "Rationale", "Alternatives", "How it works", "Consequences", "Touches", "Supersedes"];
export const DESIGN_SECTIONS = ["Summary", "How it works", "Key files", "Pitfalls", "Decisions"];
export const SPEC_HEADER = ["Status", "Branch", "Decisions", "Design"];

const DECISION_FILE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const DESIGN_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const SPEC_FILE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_PATH = /docs\/(?:decisions|design|specs)\/[A-Za-z0-9._-]+\.md/g;

/** The `## ` sections of a markdown body, in order, each with its text. */
function sections(lines) {
  const out = [];
  let current = null;
  for (const line of lines) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) {
      current = { name: m[1], body: [] };
      out.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return out;
}

const isBlank = (body) => body.every((l) => l.trim() === "");

function isDate(s) {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function listMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/**
 * Checks the record under `root`. Returns the problems as strings, each
 * naming the file it is about; an empty array means the record has its form.
 */
export function checkRecord(root) {
  const problems = [];
  const say = (file, what) => problems.push(`${file}: ${what}`);
  const read = (rel) => readFileSync(join(root, rel), "utf8").split(/\r?\n/);

  // --- The fixed files ---------------------------------------------------
  if (!existsSync(join(root, "docs/ARCHITECTURE.md"))) say("docs/ARCHITECTURE.md", "missing — the map");
  if (!existsSync(join(root, "CHANGELOG.md"))) say("CHANGELOG.md", "missing");
  else if (!read("CHANGELOG.md").some((l) => /^## Unreleased\s*$/.test(l))) say("CHANGELOG.md", "has no `## Unreleased` section");
  const plansIgnore = join(root, "docs/plans/.gitignore");
  if (!existsSync(plansIgnore)) say("docs/plans/.gitignore", "missing — docs/plans/ is scratch space and must be ignored");
  else if (!readFileSync(plansIgnore, "utf8").split(/\r?\n/).some((l) => l.trim() === "*")) say("docs/plans/.gitignore", "does not ignore `*`");

  // --- Decisions -----------------------------------------------------------
  /** number → { file, status, supersededBy, supersedes: number[] } */
  const decisions = new Map();
  const decisionFiles = listMarkdown(join(root, "docs/decisions"));
  for (const f of decisionFiles) {
    const rel = `docs/decisions/${f}`;
    const m = DECISION_FILE.exec(f);
    if (!m) {
      say(rel, "name is not NNNN-<slug>.md");
      continue;
    }
    const number = m[1];
    const lines = read(rel);
    const title = /^# (\d{4})\. (.+)$/.exec(lines[0] ?? "");
    if (!title) say(rel, "first line is not `# NNNN. <Title>`");
    else if (title[1] !== number) say(rel, `heading says ${title[1]}, file name says ${number}`);

    const head = lines.slice(0, 8);
    const statusLine = head.find((l) => l.startsWith("Status:"));
    const dateLine = head.find((l) => l.startsWith("Date:"));
    let supersededBy = null;
    if (!statusLine) say(rel, "no `Status:` line under the heading");
    else {
      const status = statusLine.slice("Status:".length).trim();
      const sup = /^superseded by (\d{4})$/.exec(status);
      if (status === "accepted") {
        // fine
      } else if (sup) {
        supersededBy = sup[1];
      } else {
        say(rel, `Status is "${status}"; it is \`accepted\` or \`superseded by NNNN\``);
      }
    }
    if (!dateLine) say(rel, "no `Date:` line under the heading");
    else if (!isDate(dateLine.slice("Date:".length).trim())) say(rel, `Date "${dateLine.slice(5).trim()}" is not YYYY-MM-DD`);

    const secs = sections(lines);
    const names = secs.map((s) => s.name);
    const expectedOrder = DECISION_SECTIONS.filter((s) => names.includes(s));
    for (const s of DECISION_SECTIONS) {
      if (!names.includes(s)) say(rel, `section \`## ${s}\` is missing`);
    }
    const seenOrder = names.filter((n) => DECISION_SECTIONS.includes(n));
    if (seenOrder.join("|") !== expectedOrder.join("|")) say(rel, `sections are out of order: ${seenOrder.join(", ")}`);
    for (const n of names) {
      if (!DECISION_SECTIONS.includes(n)) say(rel, `section \`## ${n}\` is not one of the eight`);
    }
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    for (const n of new Set(dup)) say(rel, `section \`## ${n}\` appears twice`);
    for (const s of secs) {
      if (isBlank(s.body)) say(rel, `section \`## ${s.name}\` is empty`);
    }

    const supersedes = [];
    const supSec = secs.find((s) => s.name === "Supersedes");
    if (supSec && !isBlank(supSec.body)) {
      // `none`, or `none — why nothing covered this`, or the numbers it replaces.
      const text = supSec.body.join("\n").trim();
      if (!/^none\b/.test(text)) {
        for (const n of text.match(/\b\d{4}\b/g) ?? []) if (n !== number) supersedes.push(n);
        if (supersedes.length === 0) say(rel, "Supersedes is neither `none` nor names a record by number");
      }
    }

    if (decisions.has(number)) {
      say(rel, `number ${number} is already taken by ${decisions.get(number).file} — the next free number was meant`);
      continue;
    }
    decisions.set(number, { file: rel, supersededBy, supersedes });
  }

  // Numbers are the next free one each time, so they run without a gap.
  const numbers = [...decisions.keys()].map(Number).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    const expected = i + 1;
    if (numbers[i] !== expected) {
      say("docs/decisions", `numbers skip from ${String(expected - 1).padStart(4, "0")} to ${String(numbers[i]).padStart(4, "0")}`);
      break;
    }
  }

  // Supersession points both ways: the old record's Status names the new,
  // the new record's Supersedes names the old.
  for (const [number, d] of decisions) {
    if (d.supersededBy) {
      const target = decisions.get(d.supersededBy);
      if (!target) say(d.file, `Status says superseded by ${d.supersededBy}, which does not exist`);
      else {
        if (Number(d.supersededBy) <= Number(number)) say(d.file, `superseded by ${d.supersededBy}, an earlier or equal number`);
        if (!target.supersedes.includes(number)) say(target.file, `Supersedes does not name ${number}, whose Status says this record replaced it`);
      }
    }
    for (const n of d.supersedes) {
      const old = decisions.get(n);
      if (!old) say(d.file, `Supersedes names ${n}, which does not exist`);
      else if (Number(n) >= Number(number)) say(d.file, `Supersedes names ${n}, a later or equal number`);
    }
  }

  // --- Design docs ---------------------------------------------------------
  const referenced = new Set();
  for (const f of listMarkdown(join(root, "docs/design"))) {
    const rel = `docs/design/${f}`;
    if (!DESIGN_FILE.test(f)) say(rel, "name is not <feature>.md in lower-case words");
    const lines = read(rel);
    if (!/^# \S/.test(lines[0] ?? "")) say(rel, "first line is not `# <Feature>`");
    const secs = sections(lines);
    const names = secs.map((s) => s.name);
    for (const s of DESIGN_SECTIONS) {
      if (!names.includes(s)) say(rel, `section \`## ${s}\` is missing`);
    }
    const seenOrder = names.filter((n) => DESIGN_SECTIONS.includes(n));
    const expectedOrder = DESIGN_SECTIONS.filter((s) => names.includes(s));
    if (seenOrder.join("|") !== expectedOrder.join("|")) say(rel, `sections are out of order: ${seenOrder.join(", ")}`);
    for (const s of secs) {
      if (DESIGN_SECTIONS.includes(s.name) && isBlank(s.body)) say(rel, `section \`## ${s.name}\` is empty`);
    }

    // Every pointer to a decision resolves: the Decisions list, and the
    // `→ decisions/NNNN-…` arrows in the text.
    const text = lines.join("\n");
    for (const m of text.matchAll(/\]\(\.\.\/decisions\/([^)]+)\)/g)) {
      if (!existsSync(join(root, "docs/decisions", m[1]))) say(rel, `links to ../decisions/${m[1]}, which does not exist`);
    }
    for (const m of text.matchAll(/^- \[(\d{4}) — [^\]]+\]\(\.\.\/decisions\/(\d{4})-/gm)) {
      if (m[1] !== m[2]) say(rel, `link text says ${m[1]}, link target is ${m[2]}`);
    }
    for (const m of text.matchAll(/decisions\/(\d{4})[-.]/g)) {
      referenced.add(m[1]);
      if (!decisions.has(m[1])) say(rel, `refers to decision ${m[1]}, which does not exist`);
    }
  }

  // --- Specs ---------------------------------------------------------------
  for (const f of listMarkdown(join(root, "docs/specs"))) {
    const rel = `docs/specs/${f}`;
    const m = SPEC_FILE.exec(f);
    if (!m) say(rel, "name is not YYYY-MM-DD-<topic>.md");
    else if (!isDate(m[1])) say(rel, `date ${m[1]} in the name is not a date`);
    const lines = read(rel);
    // The header is the block above the first blank line: `Key: value`
    // lines, a long value wrapping onto the lines below it. The first four
    // keys are Status, Branch, Decisions, Design, in that order.
    const header = [];
    for (const line of lines) {
      if (line.trim() === "") break;
      const kv = /^([A-Z][A-Za-z]*):(.*)$/.exec(line);
      if (kv) header.push({ key: kv[1], value: kv[2].trim() });
      else if (header.length > 0) header[header.length - 1].value += ` ${line.trim()}`;
      else break;
    }
    SPEC_HEADER.forEach((key, i) => {
      const entry = header[i];
      if (!entry || entry.key !== key) {
        say(rel, `header line ${i + 1} is not \`${key}:\` — the header is Status, Branch, Decisions, Design, in that order`);
        return;
      }
      if (entry.value === "") say(rel, `\`${key}:\` is empty`);
      if (key === "Decisions" || key === "Design") {
        const paths = entry.value.match(DOC_PATH) ?? [];
        if (!/^none\b/.test(entry.value) && paths.length === 0) say(rel, `\`${key}:\` is neither \`none\` nor a path under docs/`);
        for (const p of paths) {
          if (!existsSync(join(root, p))) say(rel, `\`${key}:\` names ${p}, which does not exist`);
        }
      }
    });
  }

  return problems;
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === here) {
  const root = resolve(dirname(here), "..");
  const problems = checkRecord(root);
  if (problems.length === 0) {
    console.log("docs: the record has its form");
  } else {
    for (const p of problems) console.error(p);
    console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"} in the record`);
    process.exit(1);
  }
}
