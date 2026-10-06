# Dashboard

## Summary

The dashboard is the one place a person runs their gate from. Name the
provider the server's own model calls go to and set memory, issue a key to
each person who may connect, follow a run step by step and stop it, read what
the team remembers and forget what it should not, and edit the agents
and pipelines the runs use. A run is started and continued in a person's own
Claude Code session, on their own login; the dashboard says which command does
it. Everything the product does that is not a run on someone's machine is done
here, behind one secret.

## How it works

### Getting in

One secret guards the whole surface. Signing in exchanges it for an HMAC-signed
HttpOnly cookie good for thirty days; every later request is checked before any
page or management route runs. With no secret configured the admin surface
refuses to serve at all rather than serving unguarded. A browser without the
cookie is sent to the sign-in page carrying where it was going, so signing in
lands on the page that was asked for; a management call without it is refused
outright rather than redirected. Behind a reverse proxy the redirect keeps the
public address, never the loopback one the server listens on. One surface sits
outside this boundary because there is no browser on the other end: the client
API under `/api/v1/*`, which takes issued keys (`teams-and-keys.md`). There are no
roles: one secret, one person, everything. A team chosen on a page scopes which
definitions are shown, never what may be done.

### The shape

A left rail is the whole map — nine destinations (Dashboard, Agents,
Repos, Workflows, Executions, Memory, Tasks, Objections, Team), no top bar, and
a theme control fixed in the corner so it does not move between pages. Light,
dark and follow-the-system are three buttons, and the choice is applied before
the first paint, so no load flashes the wrong theme.

The home page (`/`) has two sections. "The server's own model" holds the
Providers card: the endpoints the recorder and embeddings call. "Settings"
holds two cards, Memory and Plugin.

### A panel's shape, and where its Save is

Every panel is a card, and every card has the same head: an icon, a title, a
line saying what it is for. The headings that group them belong to the page, so
a panel never carries one of its own and every heading on a surface is the same
shape.

A card that can be edited owns a named set of keys and ends in a Save of its
own — in its own footer, under the controls it writes, disabled until something
differs from what was loaded. It PUTs those keys alone; the settings endpoint
merges a patch key by key, so a card never writes a field it does not render,
and one panel cannot put back a stale copy of another's. A write that fails
says so next to the button rather than flashing "Saved" regardless. The home
page carries two such cards, Memory and Plugin. The Providers card writes
each endpoint on its own: the switch at once, the model list with a Save of
its own.

### Where a panel's rules live

A panel here is a view onto a feature, and the rules belong to the feature, not
to this page. The home page is the server's own model and its settings
(`providers.md`, `memory.md`); executions are runs and their steps
(`executions.md`, `dev-workflow.md`); workflows and agents are the
definitions a run uses (`workflows-engine.md`, `agents.md`); and
repos, team, memory, tasks and objections are the rest (`workspaces.md`,
`teams-and-keys.md`, `memory.md`, `cross-team.md`).

### Where a run is started

No page starts, restarts or continues a run. A run is driven from a person's
own Claude Code session, in a worktree on their machine, so the dashboard
names the command and the machine instead of offering a button. A workflow's
page carries a "Run it" card with `/gate:run <id> <task>` and the inputs it
needs. A finished run's page shows `gate continue <id>` when it is a
session-driven run that failed, `gate teach` for a taught branch, and
`/gate:run <workflow>` otherwise, each with the host it ran on. Its usage card shows only the tokens and cost the
run's own steps reported, and is absent when they reported none: a node the
session or its subagent did is on the person's own plan.

### Live updates

Gate is one process, so live updates arrive over an in-process bus and no
broker. A run's events are published as its session reports them on the
client API, per execution, and buffered, so a page opened mid-run still
renders the path already taken. The execution page opens its stream only
while a run is running and closes it the moment the run settles; it marks
nodes and edges as they fire, shows a step that has started but has no record
yet using the engine's own clock, and re-reads the run's row on each
completion rather than deriving state from events. Panels with no events
behind them poll on a timer. Nothing on this surface routes a run. Stop
settles a session-driven run at once — between two CLI calls such a run is
rows on this server, and its session may be long closed — and queues it for
the recorder.

### What it must never show

Sealed secrets are never returned. A provider's API key is an encrypted blob;
the API says whether one is set and nothing more, so no panel can render one
and no screenshot can leak one. A person's key and connect token are plaintext
exactly once, in the answer to the call that created them, shown next to the
line meant to be sent — reload the page and they are gone for good. Forgetting
a memory record is possible only from here: no key, agent or run can delete
one.

## Key files

- `src/middleware.ts` — the admin boundary: what is guarded, what is exempt, where an unauthenticated caller goes
- `src/lib/admin-auth.ts` — the session cookie: minting, expiry, constant-time checks
- `src/app/login/page.tsx` — the one form outside the boundary
- `src/app/layout.tsx` — the shell: rail, theme applied before first paint
- `src/components/sidebar.tsx` — the map of the surface, and sign-out
- `src/app/page.tsx` — the home page: the server's own model and the settings
- `src/components/providers-panel.tsx`, `src/components/settings-panel.tsx` — the Providers card, and the Memory and Plugin cards with the keys each owns
- `src/events/bus.ts` — run events with their per-execution replay buffer
- `src/app/executions/[id]/page.tsx` — the live run: stream, graph, steps, stop, and the command that continues it
- `src/app/api/executions/[id]/cancel/route.ts` — Stop, settling a session-driven run on the spot
- `src/app/workflows/[id]/page.tsx` — the definition, and its "Run it" card
- `src/components/workflow-graph.tsx` — the canvas, shared by the definition and execution views; it renders, never routes
- `src/components/save-row.tsx` — the footer an editable card ends in: the dirty-aware Save and the error a failed write returned
- `src/components/ui/` — the shared primitives everything is built from; colours come from CSS variables, both schemes

## Pitfalls

- A page is not a permission boundary: anyone with the admin secret has every page, including keys, secrets and delete.
- The bus is in memory. A restart loses the replay buffers; the database still has the runs.
- The command a run's page shows works only on the machine named beside it: the run's worktree is on that disk.
- A stream is opened only for a run that is running. A run that settles while the page is open stops updating by design, not by failure.
- Editors pass a half-finished definition through on purpose: the file is re-parsed on save, so the error shown is the real one and an invalid edit is refused at the server, not in the form.
- A key or connect token not copied from the panel that issued it cannot be recovered — issue another one.
- A control added to a card whose key is not in that card's owned set will appear to save and not persist: the card PUTs its declared keys, nothing more.

## Decisions

- [0013 — A card saves what it shows](../decisions/0013-a-card-saves-what-it-shows.md)
- [0047 — A run is driven only from a person's own Claude Code session](../decisions/0047-a-run-is-driven-only-from-a-persons-session.md)
- [0046 — Every person runs on their own Claude login; gate holds no model credentials and serves no models](../decisions/0046-every-person-runs-on-their-own-claude-login.md)
- [0011 — Three auth surfaces, three rules](../decisions/0011-three-auth-surfaces-three-rules.md) (superseded by 0046: two surfaces remain, with the same rules)
- [0010 — Forgetting is a person's, and only from the dashboard](../decisions/0010-forgetting-is-a-persons-and-only-from-the-dashboard.md)
