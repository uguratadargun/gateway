import { loadSettings } from "@/lib/settings";
import { GateModelProvider } from "@/providers/gate-provider";
import type { ModelProvider } from "@/providers/types";

import { extractRun } from "./extract";
import { pendingExtractions, releaseStaleExtractions } from "./store";

/**
 * When the recorder runs.
 *
 * A finished run puts a row in the ledger (executions/store does that, in the
 * same statement that closes the run); this is what works the ledger off. It
 * is asked to after every finish, and it sweeps whatever else is waiting —
 * a run that finished while the server was down, a failure with attempts
 * left — so nothing depends on the one call that happened to trigger it.
 * One drain at a time per process; a second ask while one is going is a
 * note to go round again.
 */

const g = globalThis as unknown as { __gateMemoryDrain?: Promise<void> | null; __gateMemoryAgain?: boolean };

let providerForDrain: (() => ModelProvider) | null = null;

/** Tests swap the model out; the server records through its own gateway. */
export function setExtractionProvider(factory: (() => ModelProvider) | null): void {
  providerForDrain = factory;
}

export async function drainExtractions(provider?: ModelProvider): Promise<number> {
  const settings = loadSettings();
  if (!settings.memory.enabled) return 0;
  const model = provider ?? (providerForDrain ? providerForDrain() : new GateModelProvider());
  releaseStaleExtractions();
  let done = 0;
  // A bounded pass: a backlog of hundreds is worked off across several asks,
  // and no single request handler is held for all of it.
  for (const row of pendingExtractions(10)) {
    const outcome = await extractRun(row.executionId, model, { model: settings.memory.model });
    if (outcome) done++;
  }
  return done;
}

/**
 * Fire-and-forget: the caller has just settled a run and should not wait for
 * the recorder. Errors are swallowed here because the ledger row already
 * carries them; the run's page shows what happened.
 */
export function scheduleExtraction(): void {
  if (!loadSettings().memory.enabled) return;
  if (g.__gateMemoryDrain) {
    g.__gateMemoryAgain = true;
    return;
  }
  const go = async () => {
    try {
      do {
        g.__gateMemoryAgain = false;
        await drainExtractions();
      } while (g.__gateMemoryAgain);
    } catch {
      // Recorded on the ledger row; nothing to do here.
    } finally {
      g.__gateMemoryDrain = null;
    }
  };
  g.__gateMemoryDrain = new Promise<void>((resolve) => setImmediate(() => go().then(resolve, () => resolve())));
}
