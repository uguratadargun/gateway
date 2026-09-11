import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Sweeps the temp directories a test run leaves behind.
 *
 * Every suite makes its own `gate-*` directory under the OS temp dir with
 * mkdtemp and most never remove it: measured here, 17,000 of them held
 * 3.3 GB and filled the disk. This runs once after the whole run and removes
 * the `gate-*` entries created since it started — those and only those, so
 * a run happening alongside keeps its own.
 */
export function setup(): () => void {
  const startedAt = Date.now() - 1_000;
  return () => {
    const root = tmpdir();
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith("gate-")) continue;
      const path = join(root, name);
      try {
        const st = statSync(path);
        if (!st.isDirectory() || (st.birthtimeMs || st.ctimeMs) < startedAt) continue;
        rmSync(path, { recursive: true, force: true });
      } catch {
        // gone already, or not ours to remove
      }
    }
  };
}
