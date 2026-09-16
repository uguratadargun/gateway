#!/usr/bin/env node
/**
 * Moves what is under `## Unreleased` in CHANGELOG.md under a new version
 * heading, so a release commit carries the changelog with it.
 *
 * The version is GATE_VERSION in src/lib/protocol.ts — the number the release
 * bumps first — and the date is today, unless both are given:
 *
 *   npm run changelog:release                  # GATE_VERSION, today
 *   npm run changelog:release -- 0.38.0 2026-09-20
 *
 * It refuses when there is nothing under Unreleased (a release that changed
 * nothing is not a release) and when the version already has a heading (the
 * release was already cut). `Unreleased` stays, empty, at the top: the next
 * change writes there.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UNRELEASED = /^## Unreleased[ \t]*\n/m;
const HEADING = /^## /m;

/**
 * The changelog with Unreleased moved under `## <version> — <date>`.
 * Pure: takes the text, returns the text, throws with a reason it cannot.
 */
export function release(changelog, version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a date: ${date}`);
  const open = UNRELEASED.exec(changelog);
  if (!open) throw new Error("CHANGELOG.md has no `## Unreleased` section");
  if (new RegExp(`^## ${version.replace(/\./g, "\\.")}(\\s|$)`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md already has a heading for ${version}`);
  }
  const start = open.index + open[0].length;
  const rest = changelog.slice(start);
  const next = HEADING.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).replace(/^\s+|\s+$/g, "");
  if (!body) throw new Error("nothing under `## Unreleased`: a release that changed nothing is not a release");
  const tail = next ? rest.slice(next.index) : "";
  return `${changelog.slice(0, start)}\n## ${version} — ${date}\n\n${body}\n\n${tail}`;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [versionArg, dateArg] = process.argv.slice(2);
  const version =
    versionArg ?? /GATE_VERSION = "([^"]+)"/.exec(readFileSync(resolve(root, "src/lib/protocol.ts"), "utf8"))?.[1];
  const date = dateArg ?? new Date().toISOString().slice(0, 10);
  const path = resolve(root, "CHANGELOG.md");
  try {
    writeFileSync(path, release(readFileSync(path, "utf8"), version, date));
    console.log(`CHANGELOG.md: Unreleased is now ${version} — ${date}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
