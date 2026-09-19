Status: done
Branch: main
Decisions: docs/decisions/0022-a-session-gate-starts-begins-in-auto-mode.md
Design: docs/design/remote-sessions.md

# A session gate starts begins in auto mode

## Task

Asked: a run started from the gate does not begin in auto mode — fix it, in
the gate plugin and in the cockpit alike, so a session always starts there.
The report was of runs standing still between nodes while each read, write
and command of theirs waited as its own approval in the cockpit.

## Done

- `RemoteManager.spawn` passes `--permission-mode auto` for every session the
  gate server starts, a fresh one and a `--resume` alike, alongside the
  `--settings` and `--plugin-dir` it already passed. Not `bypassPermissions`,
  which Claude Code refuses when the process is root — how a gate runs as a
  service. What auto mode will not decide still reaches the person's cockpit
  through the hub, unchanged.
- The cockpit's own spawn passes the same flag, so a session is the same
  thing on a desktop and on the server (the cockpit's `src/main/index.ts`,
  released as 0.2.2).
- Nothing changed for a headless worker: `--permission-mode auto
  --permission-prompts none` has been what a `claude-code` node runs under
  since it existed. This change makes the node a session does cost the same
  as the node a worker does.
- `tests/remote.test.ts` holds the spawn to the flag.

Run: `npx vitest run tests/remote.test.ts` (5 passed), `npm run typecheck`,
`npm run docs:check` (clean), `npm test` (737 passed, 2 skipped).
