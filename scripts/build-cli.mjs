#!/usr/bin/env node
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundles the client CLI into the plugin.
 *
 * One file, because that is what a plugin can ship: a developer installs the
 * plugin and has a working `gate` without an npm install, a build step, or a
 * checkout of this repository. The engine and the loaders go in with it, so a
 * definition is parsed by the same code on both sides of the connection.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The three places a version is written have to agree.
 *
 * Installs are cached by version — ~/.claude/plugins/cache/<marketplace>/<plugin>/<version> —
 * so a plugin whose contents changed while its version did not is a plugin that
 * never reaches anyone: `plugin update` sees the number it already has and does
 * nothing, silently. Anything shipped under plugins/ or src/client/ therefore
 * needs a bump, and these three must move together: the client compares its own
 * GATE_VERSION against the server's.
 */
const versions = {
  "plugin.json": JSON.parse(readFileSync(resolve(root, "plugins/gate/.claude-plugin/plugin.json"), "utf8")).version,
  "marketplace.json": JSON.parse(readFileSync(resolve(root, ".claude-plugin/marketplace.json"), "utf8")).plugins.find(
    (p) => p.name === "gate",
  ).version,
  "protocol.ts": /GATE_VERSION = "([^"]+)"/.exec(readFileSync(resolve(root, "src/lib/protocol.ts"), "utf8"))?.[1],
};
const distinct = [...new Set(Object.values(versions))];
if (distinct.length !== 1) {
  console.error("version mismatch — these must agree, or an update reaches nobody:");
  for (const [file, version] of Object.entries(versions)) console.error(`  ${file}: ${version}`);
  process.exit(1);
}
console.log(`gate ${distinct[0]}`);

/**
 * Warns when the plugin has changed since its version last did.
 *
 * The check above catches the three numbers disagreeing; it cannot catch all
 * three being equally stale, which is the failure that actually keeps
 * happening — a commit ships a new command file or a new bundle under a
 * version somebody already installed, and their `plugin update` fetches the
 * number it has and does nothing. Advisory, not fatal: mid-feature the answer
 * is often "not yet".
 */
try {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  // -G, not -S: a bump changes the value on the version line, not how many
  // times the word appears, and -S only notices the latter.
  const lastBump = git(["log", "-1", "--format=%H", "-G", '"version":', "--", "plugins/gate/.claude-plugin/plugin.json"]);
  if (lastBump) {
    const since = git(["log", "--oneline", `${lastBump}..HEAD`, "--", "plugins", "src/client"]);
    if (since) {
      console.warn(`\n⚠ these commits ship plugin changes at ${distinct[0]}, which may already be installed:`);
      for (const line of since.split("\n")) console.warn(`   ${line}`);
      console.warn("  Bump the version, or an update reaches nobody.\n");
    }
  }
} catch {
  // No git, a shallow clone, or a fresh repo: the check is a courtesy.
}

await build({
  entryPoints: [resolve(root, "src/client/entry.ts")],
  outfile: resolve(root, "plugins/gate/scripts/gate.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // The server is not part of this: anything that reaches for next/server or
  // node:sqlite has been imported by mistake, and the build should say so
  // rather than quietly producing a CLI that cannot start.
  external: ["next/*", "next"],
  alias: { "@": resolve(root, "src") },
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
