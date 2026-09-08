#!/usr/bin/env node
import { build } from "esbuild";
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
