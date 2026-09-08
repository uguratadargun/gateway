import { main } from "./cli";

/**
 * The bundled CLI's entry point. Everything it needs — the engine, the
 * registries, the loaders — is bundled with it, so the plugin ships one file
 * and a developer needs nothing installed but node and git.
 */
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
