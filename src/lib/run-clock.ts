/**
 * A run's clock, with the person's time left out.
 *
 * A session-driven run spends part of its life waiting — a question put to
 * the person, a plan shown for approval, a branch handed over to try. That
 * time is theirs, and a run that says "2h 14m" because someone went to lunch
 * with the plan open is not telling anyone how long the work took. So the
 * elapsed time is the wall clock minus every pause, the one still open
 * included, and the status the dashboard shows says *paused* while it is.
 */

export interface RunClock {
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt: number | null;
  pausedAt?: number | null;
  pausedMs?: number;
}

/** Wall time the run has actually been working, up to `now` or its end. */
export function runElapsed(run: RunClock, now: number): number {
  const end = run.finishedAt ?? now;
  const open = run.pausedAt != null ? Math.max(0, end - run.pausedAt) : 0;
  return Math.max(0, end - run.startedAt - (run.pausedMs ?? 0) - open);
}

export type RunDisplayStatus = RunClock["status"] | "paused";

/** What to call the run: a running one waiting on the person is "paused". */
export function runStatus(run: RunClock): RunDisplayStatus {
  return run.status === "running" && run.pausedAt != null ? "paused" : run.status;
}
