# Remote sessions

## Summary

A person can run a Claude Code session on the gate server instead of on
their own machine — the laptop can close and the session goes on. It is the
same thing as a local session, moved: a real interactive terminal on the
server, in one of the team's connected repositories, whose screen streams to
the person's cockpit and whose questions and permission prompts wait for
them there. A `/gate:run` started in it is an ordinary run on the person's
own key, in their run list like any other.

## How it works

### What a session is

A session on the desktop is a `claude` in a pty the cockpit owns. Here it is
the same thing owned by the gate process: a real interactive `claude` in a
pty on the server, in one of gate's connected repositories (`/repos`),
driven over `/api/v1/remote`. Its bytes are streamed to the cockpit, its
keystrokes are posted back, its questions and approvals are held until the
person answers. Nothing about the session is emulated, and the run it
starts is an ordinary `/gate:run`: the same plugin, a worktree per run,
reported on the person's own key.

The plugin is loaded from the server checkout's own `plugins/gate` with
`--plugin-dir`, so it is always the server's version; nothing is installed
for it. The child runs as the user gate runs as, in the repository's
checkout, and is given its person's key — `GATE_KEY`, and
`ANTHROPIC_AUTH_TOKEN` against this gate's own gateway, so every model call
is metered as theirs — and none of the server's environment: everything
under `GATE_*`, `ANTHROPIC_*`, `CLAUDE_*`, `NEXT_*`, `npm_*` and the
framework's internals is dropped before the child starts. `GATE_SELF_URL`
is where the child reaches this gate when it is not
`http://127.0.0.1:$PORT`.

Each person has their own Claude Code config directory and their own gate
client home under `~/.gate/remote/people/<person>/`, so one person's
transcripts, pinned run definitions and session pointers are never
another's. Claude Code's first-run prompts — onboarding, and "do you trust
this folder" for the repository — are settled in that config directory
before the first session, so the person does not meet them in every
repository on a machine they never chose to trust anything on.

### Who may

Keys with the `remote` scope, issued deliberately like `author`, since a
session is an interactive terminal on the server running as gate's own
user. A key sees only its own sessions: another person's terminal,
questions and runs read as not there at all. `GET /api/v1/remote` says
whether the key may run sessions here, whether this server can host them at
all, and which repositories they can open in; "not allowed" is something a
cockpit shows, not an error.

### Questions and approvals

Every hook of every remote terminal is a small shim the server writes
(`remote-hook.cjs`) and points Claude Code's hooks at through a settings
file. Each hook reads its payload on stdin, tags it with the terminal it
came from and that terminal's token, and forwards it over a unix socket to
the gate process as one NDJSON frame. A frame whose token is not its
terminal's is dropped: the socket is the gate user's alone (0600), and the
token keeps one session from answering for another. Most events are
answered at once and only reported — they are what tells the cockpit the
session is working, idle, waiting or blocked. Two are held open until the
person answers, from a cockpit anywhere: the `AskUserQuestion` PreToolUse and
`PermissionRequest`. The terminal never shows those prompts; the cockpit
does, in Questions and Approvals like any other, and answers them through
`/api/v1/remote/asks/<id>`, after which the session goes on at once. If gate
is gone the shim's connect fails, it prints nothing, and the TUI asks as it
always does.

A session starts in auto mode (`--permission-mode auto`), as one the cockpit
starts on a desktop does. Nobody is sitting at this terminal: in the default
mode every read, write and command a `/gate:run` makes would travel to a
cockpit as its own approval, and the run would spend its nodes waiting on
them. `auto` decides without asking and still hands over what it will not
decide, so the person is asked about what is genuinely theirs and nothing
else. Not `bypassPermissions`: Claude Code refuses that outright when the
process is root, which is how a gate runs as a service. Shift+Tab in the
terminal changes the mode for that session, as it does anywhere.

A terminal that exits takes its held prompts with it. The settings file the
child starts with sets `includeCoAuthoredBy: false`, for the same reason the
headless worker does: a commit a run makes is the team's.

### Lifetime

A session outlives the connection that started it: closing the cockpit
leaves it running, a question it asks waits, and the next stream replays
each terminal's recent output (the last 256 KB) so a cockpit that connects
to a session already going sees its screen. `/api/v1/remote/stream` opens
with a hello — every session and everything waiting — then each live
terminal's recent output, then terminal output, exits and list changes as
they happen; a cockpit that drops and reconnects gets the same opening
again. A terminal that has printed nothing for twelve seconds while
"working" is taken to be at its prompt.

An idle session — unwatched and holding no run — is put to sleep after
`GATE_REMOTE_IDLE_MIN` minutes (default 30, `0` never). Asleep, it is its
transcript under the person's config directory, listed beside the live
ones, and starting it again is `claude --resume` on that transcript. A run
in the session's hands is never idle, whatever the terminal looks like.
`GATE_REMOTE_MAX` caps live terminals per person (default 8). Only the gate
process ending ends the sessions, and then the transcripts are still there
and resuming works.

### A run's changes

The cockpit shows a desktop run's changed files by running `git` in the
session's directory. A remote run's directory is on the server, so
`/api/v1/remote/executions/<id>/changes` and `…/diff` do the same reading
there — the run's worktree while it has one, else the session's own
directory — and hand it back in the same shape. A path in the request that
climbs out of the worktree is refused: it came from the network.

### Needs

`node-pty` is an optional dependency, deliberately: everything else gate
does needs no native build, so a gate that cannot build it keeps working and
says why remote sessions are off instead of failing to install. On Linux it
builds from source, so a C++ toolchain is needed. `claude` has to be on the
server's PATH, or named by `GATE_CLAUDE_PATH`. `GET /api/v1/remote` says
which is missing.

### The routes

| route | what it does |
| --- | --- |
| `GET /api/v1/remote` | may this key, can this server, and which repositories |
| `GET/POST /api/v1/remote/sessions` | the caller's sessions, live then asleep; start one in a repository with an optional first prompt, or wake one |
| `GET /api/v1/remote/stream` | the caller's sessions, live, on one connection |
| `DELETE /api/v1/remote/terminals/<handle>` | close a terminal |
| `POST …/terminals/<handle>/input`, `/resize`, `/redraw` | keystrokes, a new size, a repaint |
| `GET /api/v1/remote/asks`, `POST …/asks/<id>` | what is waiting on the person; answer a question or settle a permission |
| `GET …/executions/<id>/changes`, `…/diff` | a remote run's changed files and one file's diff |

## Key files

- `src/remote/manager.ts` — the sessions: starting, listing, streaming, idling, sleeping and waking them; the child's environment
- `src/remote/hooks.ts` — the server's end of the hook socket; which events are held and how they are answered
- `src/remote/shim.ts` — the hook shim the child runs, its settings file, and where the socket lives
- `src/remote/pty.ts` — loading `node-pty` as an optional dependency, and why a missing one is a value rather than a build error
- `src/remote/transcripts.ts` — a person's sessions as their transcripts on this server, live or asleep
- `src/remote/changes.ts` — a remote run's changed files, read from its worktree here
- `src/remote/auth.ts` — the `remote` scope
- `src/remote/types.ts` — the shapes, in the cockpit's own words
- `src/app/api/v1/remote/` — the routes above

## Pitfalls

- A remote session's questions reach the cockpit only through the hook shim; when the shim cannot reach gate it prints nothing and the TUI asks in the terminal instead, where nobody is watching.
- On macOS a deep `GATE_HOME` would overflow the unix socket path; the socket then lives under a hashed name in the temp directory, not beside the data.
- The loader reaches `createRequire` through `process.getBuiltinModule("module")`, not an import: Next's server bundle rewrites a `node:module` import to a stub, and the bundled `createRequire` is then `undefined` — remote sessions read as unavailable on a server where `node-pty` is installed and working.
- `node-pty` sometimes lands without its `spawn-helper` execute bit; the server restores it before the first spawn, but a read-only install cannot be fixed and every spawn then fails with "posix_spawnp failed".
- Questions from a session running in a desktop cockpit on the person's own machine are held by that cockpit, not by the server; they do not show here.
- The idle timer does not sleep a session holding a run, and a sleeping session is not a stopped run: the run's own rules on silence still apply (see `executions.md`).

## Decisions

- none recorded yet
