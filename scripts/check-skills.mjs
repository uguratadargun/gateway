#!/usr/bin/env node
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Runs src/scripts/check-skills.ts against this machine's ~/.gate.
 *
 * Bundled on the way, the same way the client CLI is: the source uses the
 * `@/` alias and is TypeScript, and this has to work with nothing but the
 * repository's own dev dependencies — no global tsx, no build step to remember.
 * The bundle lives in a temporary directory for the length of the run.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "gate-check-"));
const outfile = join(dir, "check-skills.mjs");
try {
  await build({
    entryPoints: [resolve(root, "src/scripts/check-skills.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["next/*", "next"],
    alias: { "@": resolve(root, "src") },
    logLevel: "warning",
  });
  await import(pathToFileURL(outfile).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
