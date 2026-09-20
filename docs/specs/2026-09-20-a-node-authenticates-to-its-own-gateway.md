Status: done
Branch: gate/run-525fd5c1
Decisions: docs/decisions/0023-a-run-carries-a-token-of-its-own.md
Design: docs/design/gateway-pipeline.md, docs/design/agents-and-skills.md, docs/design/executions.md

# A node authenticates to its own gateway

## Goal

A workflow run on the gate server fails its first `claude-code` node: the
spawned Claude Code opens with no credentials, gets `Not logged in · Please
run /login` on its first request, and dies. gate reports it outwards as
`MODEL_EXECUTION_ERROR` — `claude-code did not finish (success)` — and the
real reason stays in the logs. `input_tokens` is 0, so nothing reached a model
and nothing was billed.

The cause is in three parts, and all three are fixed here.

1. **No credential.** `src/runtime/executors/claude-code.ts:277-281` sets
   `ANTHROPIC_BASE_URL` for the child but sets `ANTHROPIC_AUTH_TOKEN` /
   `ANTHROPIC_API_KEY` only when `deps.authToken` exists, on the comment "on
   the server the gateway is loopback and needs no key". That premise is false
   on any gate that has issued keys: `gatePrincipal()` in
   `src/lib/gate-auth.ts` returns `null` for a tokenless request as soon as
   `hasActiveKeys()` is true, whatever the source address. The server will mint
   a token for the run, hand it to the child, and resolve it back to the run's
   own principal.
2. **The error a person reads.** A failed child's own reason — which it does
   print, on stderr and in its result event — never reaches the node's error.
   It will.
3. **Where the child sends its calls.** On the server the child currently
   leaves through `GATE_SELF_URL`'s public address, behind Caddy, and comes
   back in. It will go to the loopback gateway instead.

Out of scope: trusting loopback in the gateway; an operator-configured
`GATE_SELF_KEY`; changing what `GATE_SELF_URL` means for anything else that
uses it (`src/remote/manager.ts:103` keeps it); recording an owner on runs that
have none (see Assumptions); any change to the developer's-machine path, where
`src/client/run.ts:178` passes `gatewayUrl` and the person's key and still
wins.

## Approach

**The seam for authentication is a run-scoped token registry that lives in
memory, beside the run rather than beside the issued keys.** A new module
`src/lib/run-tokens.ts` owns it: nothing else knows how a run token is made,
stored or matched. `src/lib/gate-auth.ts` gains exactly one line of policy —
consult that registry before anything else — and `src/executions/runner.ts`
gains exactly one wrapper around the run it already launches. No table, no
migration, no `apikeys` row: a token that outlives its run, or that a restart
leaves behind, is the thing this shape makes impossible.

The registry's public surface is two functions and no globals anybody else
touches:

```ts
/** Runs `body` with a bearer token that authenticates as this run, and drops
 *  the token however the run ends. */
export async function withRunToken<T>(
  executionId: string,
  principal: Principal,
  body: (token: string) => Promise<T>,
): Promise<T>;

/** The principal behind a run token, or null when this process minted no such token. */
export function resolveRunToken(token: string): Principal | null;
```

`withRunToken` takes a whole `Principal` rather than building one, so
`run-tokens.ts` imports only the `Principal` type from `./apikeys` and nothing
from `gate-auth.ts` — which imports *it*. That direction is deliberate: the
reverse would be an import cycle.

**The principal is the run's own**, read off the execution row the runner
already has: `{ keyId: INTERNAL_KEY_ID, userId: <row>.userId, teamId:
<row>.teamId, scopes: ["gateway"] }`. This is the same identity
`src/providers/gate-provider.ts:36` already gives gate's in-process calls
(decision 0017), so the traffic log gains no new label: a run with an owner
reads as that person, one without reads `workflow`, and both read the run's
team rather than `local` or the default team. `scopes: ["gateway"]` and nothing
more — the client API (`src/lib/tenancy.ts`) resolves keys through `resolveKey`
directly and never calls `gatePrincipal`, so a run token cannot reach `/api/v1/*`
at all, and this keeps it that way if that ever changes.

**Where the check goes.** `gatePrincipal` is the one door: the three gateway
endpoints call it for the principal, and `count_tokens`, `batches/*` and
`/v1/models` call it through `gateAuthOk` for the boolean. Putting the registry
lookup first in `gatePrincipal` therefore covers every call the child makes,
including the background ones, and it must be first: a run token is not an
issued key, so on a gate that has issued any, every branch below would refuse
it, and where `GATE_API_KEY` is set it would fail the equality.

**Where the token is minted.** `launch()` in `src/executions/runner.ts` is the
only place a server-side run of the engine begins, and it already knows the
`executionId`, already reads the store, and already has one settled path for
success and one for failure. Wrapping its body in `withRunToken` gives the
token exactly the run's lifetime with no third place to remember to clean up.
The token is passed on as `claudeCode: { authToken: runToken }` — the option
the engine and `src/runtime/executors/agent.ts` already thread through to the
executor. `gatewayUrl` is left unset there, because the executor's own default
is now the right answer on the server.

**Where the child sends its calls.** `gatewayUrl()` in the executor loses its
`GATE_SELF_URL` branch and keeps two cases: the override a client passes, else
`http://127.0.0.1:${PORT ?? 4141}/api/gateway`. That is the same loopback rule
`src/remote/manager.ts:102-105` uses, so the two agree. A node's streamed
traffic then never makes a proxy round trip and cannot hit Caddy buffering or a
proxy timeout on a long stream.

**The error.** One helper in the executor assembles the child's own account —
its result text when it has one, else what it printed on stderr, truncated to
500 characters as the neighbouring branch already truncates — and both failure
branches use it. Nothing else about the failure changes: the code stays
`MODEL_EXECUTION_ERROR`, the tool calls and usage stay attached as evidence,
and the permission-denial clause stays.

Nothing under `plugins/` or `src/client/` changes, so no version bump.

## Assumptions

- The run's principal is read off the execution row, so a run started from the
  dashboard — where 0011 records one administrator and no per-person session,
  and `startExecution` writes no `userId` — has `userId: null` and its rows
  read `workflow` with the run's team. Nothing is added here to invent an owner
  for such a run; "the owner and team of the execution" is taken literally, and
  where the execution has no owner there is none to name.
- `keyId` is the existing `INTERNAL_KEY_ID` (`"workflow"`) sentinel, not a new
  one, so `/traffic` gains no new label and `callerLabel` needs no change.
- The token's life is the run's, with no wall-clock TTL: a run has no fixed
  length and a short clock would kill a long node mid-stream. The registry is
  in memory only, so a restart invalidates every token by construction and
  nothing is ever persisted as an issued key.
- The token carries the `gateway` scope and no other.
- The decision record is `0023` — the next free number in this worktree.
  `npm run docs:check` fails on both a duplicate number and a gap, so if the
  branch already carries a 0023 by the time it is written, take the next free
  one and the check will say so.
- Decision 0011 is **not** edited. This adds a case to the gateway surface's
  admission rule rather than reversing the three-surfaces decision, so 0011
  keeps `Status: accepted` and the new record names it in Context. What is
  reversed is an assumption that lived only in a code comment.
- No version bump in `plugin.json` / `marketplace.json` / `GATE_VERSION`:
  nothing shipped under `plugins/` or `src/client/` changes.

## Baseline

`npm test` (vitest, the whole suite), run in
`/Users/ugur/.gate/workspaces/525fd5c1-5d2d-4834-b9ed-abe9a12831bf`:

```
Test Files  79 passed | 1 skipped (80)
     Tests  737 passed | 2 skipped (739)
  Duration  7.69s
```

Exit 0. **Green** — nothing was red before this run started, and the two
skipped tests were already skipped. `npm run docs:check` runs inside the suite
via `tests/docs-record.test.ts`, so the record's form is covered by the same
command. `npm run typecheck` is the other gate and is to be run at the end of
every task.

## Documentation

This change makes a real choice — gate's own children authenticate to gate's
own gateway with a token minted for the run, where the recorded assumption was
that a server-side child needed no credential at all — so it gets a decision
record:

- `docs/decisions/0023-a-run-carries-a-token-of-its-own.md`

Design docs to make true (rewritten as the present tense of the feature, never
as "what changed"):

- `docs/design/gateway-pipeline.md` — the **Auth** paragraph gains the run
  token as the first case the bearer token is resolved against; the
  **Accounting** paragraph's sentence about `workflow` and `local` says that a
  node's spawned Claude Code answers as the run's own person and team over the
  same sentinel key id; **Key files** gains `src/lib/run-tokens.ts`; the
  `gate-auth.ts` line names the run token; **Decisions** links 0023.
- `docs/design/agents-and-skills.md` — the `executor` paragraph (the sentence
  beginning "`claude-code` hands the node to a headless Claude Code in the
  worktree, pointed at this gate's own gateway") says which gateway and with
  what credential: the loopback gateway of the server with a token minted for
  the run, or the configured server with the person's key when the engine runs
  on their machine.
- `docs/design/executions.md` — the **What went wrong, in the lines that say
  so** section gains that a failed `claude-code` node carries the child's own
  reason, from its result text or what it printed, rather than only the shape
  of the failure.
- `docs/design/dev-workflow.md` and `docs/design/workflows-engine.md` — read
  the sentences about a `claude-code` node and change nothing unless one has
  become untrue; the developer's-machine path is unchanged.
- `docs/design/remote-sessions.md` — unchanged; `GATE_SELF_URL` still means
  what it says there.

Also required:

- `docs/specs/2026-09-20-a-node-authenticates-to-its-own-gateway.md`
- one line under `## Unreleased` in `CHANGELOG.md`

Every commit whose change touched the record names those files in its body on
one line: `Documents: …`.

### Task 1: A token that is a run, not a key

**Files**

- create `src/lib/run-tokens.ts`
- modify `src/lib/gate-auth.ts`
- test: `tests/traffic-attribution.test.ts` (extend; its describe block "who
  the gateway says is calling" is exactly this contract)

**Do**

Write `src/lib/run-tokens.ts` with the two exports named in `## Approach` and
nothing else public. Behind them:

- A registry hung off `globalThis` — follow `src/executions/runner.ts:63-65`
  (`__gateRunsInFlight`) and its comment for why: route handlers and the runner
  do not share a module registry in dev, and a per-module `Map` would leave the
  gateway looking at an empty one. Name it `__gateRunTokens`.
- Two maps, or one map plus a reverse index: token → `Principal`, and
  `executionId` → token, so a second mint for the same run replaces the first
  rather than leaking it.
- The token is `gate_run_` followed by `randomBytes(24).toString("hex")` — 192
  bits, and visibly not an issued key, which is `gate_` + 48 hex.
- `withRunToken` mints, calls `body(token)`, and drops the token in a `finally`
  so a throw drops it too. It must mint **before** its first `await`, so that
  the token exists the moment the function is called.
- `resolveRunToken` returns `null` for an empty string and for anything not in
  the registry. A plain map lookup on a 192-bit random token; no hashing, no
  database.
- File-head comment says what the module is for: a token that authenticates as
  one run, alive only while that run is, never written down. Say that a restart
  invalidates every token and that this is the point.

In `src/lib/gate-auth.ts`, `gatePrincipal` consults it first:

```ts
const token = bearerToken(req);
// A run this process is holding right now, answering as the person and team
// it is for. First, because a run token is not an issued key: on a gate that
// has issued any it would be refused below, and where GATE_API_KEY is set it
// would fail the equality.
const run = token ? resolveRunToken(token) : null;
if (run) return run;
```

Everything below is untouched.

**Test**

In `tests/traffic-attribution.test.ts`, written first:

- A run token resolves to the run's principal **even though keys are issued**:
  `createKey({ name: "someone-else" })` so `hasActiveKeys()` is true, then
  inside a `withRunToken(...)` body assert `gatePrincipal(request(token))`
  matches `{ keyId: INTERNAL_KEY_ID, userId: "u-1", teamId: DEFAULT_TEAM_ID }`
  and that its scopes are `["gateway"]`.
- The token dies with the run: capture it inside the body, assert
  `gatePrincipal(request(token))` is `null` after `withRunToken` resolves, and
  again after a `withRunToken` whose body throws (the throw still propagates).
- A run token also wins where `GATE_API_KEY` is set to something else.
- An unknown `gate_run_…` string is still `null`.

`npx vitest run tests/traffic-attribution.test.ts`

**Done when**

A token minted for a run authenticates on the gateway as that run's person and
team on a gate that has issued keys; the same token authenticates as nobody
once the run has ended, either way it ended; no row is written to `apikeys`;
`npm run typecheck` passes.

### Task 2: The server mints one for every run it launches

**Files**

- modify `src/executions/runner.ts`
- test: `tests/traffic-attribution.test.ts` (the lifetime is already covered by
  Task 1's `withRunToken` tests; what is added here is covered below)

**Do**

In `launch()`, read the run's row — `getExecution(executionId)` is already
imported — and wrap the whole existing body in `withRunToken`, passing
`{ keyId: INTERNAL_KEY_ID, userId: record?.userId ?? null, teamId:
record?.teamId ?? scope.teamId ?? DEFAULT_TEAM, scopes: ["gateway"] }`.
`INTERNAL_KEY_ID` comes from `@/lib/gate-auth`, `withRunToken` from
`@/lib/run-tokens`; `DEFAULT_TEAM` is already imported from `@/lib/def-root`.

Inside, the call to `runWorkflow` gains one option:

```ts
claudeCode: { authToken: runToken },
```

`gatewayUrl` is deliberately left unset: the executor's default is the loopback
gateway of this process (Task 3). Say that in a comment, with why the token is
there at all — a gate that has issued keys refuses a tokenless request whatever
its source address, so a node's child arrived as nobody.

The `try` / `catch` inside stay as they are; `withRunToken`'s `finally` is what
drops the token, including on the crash path that already writes a failed
state.

Nothing else in this file changes. `src/client/run.ts` is untouched: a run on a
developer's machine still passes that person's key and their server's gateway
URL, and that still wins because it is a different call site.

**Test**

No new test file. Task 1 already holds `withRunToken` to minting before its
first await and dropping in a `finally`; what this task adds is the wiring, and
the assertion that covers it is `npm run typecheck` plus the whole suite —
`tests/engine.test.ts`, `tests/resume.test.ts` and `tests/executions.test.ts`
must stay green, since the wrapper changes the shape of `launch`'s body.

`npx vitest run tests/engine.test.ts tests/executions.test.ts tests/resume.test.ts`

**Done when**

Every run the server launches has a token in the registry from before its first
node until after it settles; that token is what a `claude-code` node's child is
given; the token is gone once the run has ended or failed; the whole suite and
`npm run typecheck` pass.

### Task 3: The child calls the gateway that is on this machine

**Files**

- modify `src/runtime/executors/claude-code.ts`
- test: `tests/claude-code-executor.test.ts`

**Do**

Delete the `GATE_SELF_URL` branch from `gatewayUrl()`, leaving the override and
the loopback default:

```ts
function gatewayUrl(override?: string): string {
  if (override) return override.replace(/\/$/, "");
  return `http://127.0.0.1:${process.env.PORT ?? 4141}/api/gateway`;
}
```

Rewrite the doc comment above it to say why loopback and not `GATE_SELF_URL`:
the child runs on the same host as the gateway that meters it, so going out
through the public address behind the reverse proxy is a round trip that buys
nothing and exposes a long stream to proxy buffering and timeouts.
`GATE_SELF_URL` still means what it means for `src/remote/manager.ts`, which is
a URL a *person's* cockpit has to be able to reach.

In the same file, rewrite the stale comment at the `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_API_KEY` lines. The code is unchanged — set both when
`deps.authToken` is there, set neither when it is not — but "on the server the
gateway is loopback and needs no key" is the false premise this whole change
corrects. It now says: the server passes a token minted for the run, a
developer's machine passes that person's key, and an empty value would be sent
as one, which is why the spread is conditional.

**Test**

In `tests/claude-code-executor.test.ts`, written first — a test that sets
`GATE_SELF_URL` (restore it afterwards, or use `vi.stubEnv` with
`vi.unstubAllEnvs`) and asserts the spawned child's
`env.ANTHROPIC_BASE_URL` is `http://127.0.0.1:4141/api/gateway`, not the public
address. Reuse the env-capturing `spawnCli` wrapper already at the bottom of
that file. A second assertion in the same test: with `PORT` set to something
else, the loopback URL follows it. The existing test that an explicit
`gatewayUrl` override is used verbatim must stay green.

`npx vitest run tests/claude-code-executor.test.ts`

**Done when**

A child spawned on a server with `GATE_SELF_URL` set goes to
`http://127.0.0.1:<PORT>/api/gateway`; an override still wins verbatim;
`GATE_SELF_URL` has exactly one reader left in the tree (`src/remote/manager.ts`).

### Task 4: A failed child says what went wrong

**Files**

- modify `src/runtime/executors/claude-code.ts`
- test: `tests/claude-code-executor.test.ts`

**Do**

Add one module-level helper — the child's own account of why it stopped,
preferring what it reported over what it printed:

```ts
/** The child's own account of why it stopped, for the error a person reads. */
function failureDetail(r: CliResult | null, stderr: string): string {
  const said =
    typeof r?.result === "string" ? r.result.trim()
    : r?.result == null ? ""
    : JSON.stringify(r.result);
  return (said || stderr.trim()).slice(0, 500);
}
```

`r.result` is checked for `null`/`undefined` before `JSON.stringify`, because
`JSON.stringify(undefined)` is not a string and would poison the message.

Use it in both failure branches:

- The branch where no `result` line arrived at all (`if (!parsed)`) replaces its
  inline `(stderr.trim() || "no output")` with
  `failureDetail(null, stderr) || "no output"` — same behaviour, one place.
- The branch where the result line says it did not finish
  (`parsed.is_error || typeof parsed.result !== "string"`) appends
  ` — ${why}` to its message when `failureDetail(parsed, stderr)` is non-empty,
  before the existing permission-denials clause. So the observed failure reads
  `node "planner": claude-code did not finish (success) — Not logged in ·
  Please run /login` instead of stopping at the subtype.

Nothing else moves: the code stays `MODEL_EXECUTION_ERROR` and the `usage` and
`toolCalls` evidence stays attached.

**Test**

In `tests/claude-code-executor.test.ts`, written first, two cases:

- A result line with no `result` field and `subtype: "success"` — the exact
  shape of the reported failure — with `Not logged in · Please run /login` on
  the child's stderr. Expect a rejection of `MODEL_EXECUTION_ERROR` whose
  message contains both `(success)` and `Not logged in`.
- A result line with `is_error: true` and a `result` string carrying the
  reason, with unrelated noise on stderr. Expect the message to carry the
  result text, not the stderr noise — the child's own report wins.

The existing test "reports the CLI's own failure rather than a parse error"
must stay green.

`npx vitest run tests/claude-code-executor.test.ts`

**Done when**

A `claude-code` node that fails reports the child's own reason in the message
the dashboard shows, from its result text when it has one and from its stderr
otherwise; a failure with neither still reads as it did.

### Task 5: Documentation

**Files**

- create `docs/decisions/0023-a-run-carries-a-token-of-its-own.md`
- create `docs/specs/2026-09-20-a-node-authenticates-to-its-own-gateway.md`
- modify `docs/design/gateway-pipeline.md`
- modify `docs/design/agents-and-skills.md`
- modify `docs/design/executions.md`
- modify `CHANGELOG.md`
- read and leave alone unless untrue: `docs/design/dev-workflow.md`,
  `docs/design/workflows-engine.md`, `docs/design/remote-sessions.md`

**Do**

Write the four documents named under `## Documentation`, in the forms
`plugins/gate/reference/docs.md` describes and the existing files already use.

The decision record is logic, not code. Its **Context** is that gate's own
children have to get through gate's own front door, that the gateway's recorded
rule (0011) is an issued key with the `gateway` scope, else `GATE_API_KEY`, else
open, and that a server-side child was given none of them on the premise that
loopback needs no key — a premise `gatePrincipal` never held, and which the
public address behind the reverse proxy made doubly false. Its **Decision** is
that a run carries a token of its own: minted when the run starts, resolving to
the run's own person and team, dropped when the run ends, never written down.
Its **Alternatives** are the two that were considered and rejected — trusting
loopback inside the gateway, and an operator-configured `GATE_SELF_KEY` in the
environment — and the third that falls out of the shape: issuing a real
`apikeys` row per run. Its **Consequences** say what a token that lives only in
memory costs and buys, that a restart invalidates every live run's token, that
there is no wall-clock expiry because a run has no fixed length, and that a run
with no owner recorded reads `workflow` in the traffic log with its own team.
**Supersedes: none** — 0011 is extended, not reversed, and 0011 is not edited.
Name 0011 and 0017 in Context and in **Touches**.

The spec's header is `Status`, `Branch`, `Decisions`, `Design`, in that order:
branch `gate/run-525fd5c1`, the decision above, and the three design docs.

The `CHANGELOG.md` line goes under `## Unreleased` and says what the product
does now, in the person's terms — a run on a gate that has issued keys gets
through its own gateway, and a node that fails says why.

**Test**

none (documentation) — though `npm run docs:check` must be clean, and it also
runs inside `npm test` via `tests/docs-record.test.ts`.

**Done when**

Each design doc reads as the present tense of the feature with no trace of
"what changed"; every section of the decision record is filled — Context,
Decision, Rationale, Alternatives, How it works, Consequences, Touches,
Supersedes — with logic in it and no code; the spec's header and sections are
in form; `CHANGELOG.md` has its one line; `npm run docs:check`, `npm run
typecheck` and `npm test` are all clean, with the suite at or above the
baseline's 737 passed.
