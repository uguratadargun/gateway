import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One temp directory per test run, removed whole when the run ends.
 *
 * Every suite makes its own `gate-*` directory under the OS temp dir with
 * mkdtemp and most never remove it: measured here, 17,000 of them held
 * 3.3 GB and filled the disk. This runs before the workers start and points
 * TMPDIR — which os.tmpdir() reads on every call — at a directory of this
 * run's own; the workers inherit it, every mkdtemp lands inside, and the
 * teardown removes it. A run happening alongside has its own.
 */
export function setup(): () => void {
  const own = mkdtempSync(join(tmpdir(), "gate-run-"));
  process.env.TMPDIR = own;
  return () => {
    try {
      rmSync(own, { recursive: true, force: true });
    } catch {
      // gone already
    }
  };
}
