import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate every test run from the real ~/.gate. Must run before modules that
// read GATE_HOME at import time (db, settings, router, store).
process.env.GATE_HOME = mkdtempSync(join(tmpdir(), "gate-test-"));
process.env.GATE_SECRET = "test-secret";
process.env.GATE_ADMIN_SECRET = "test-admin-secret";
