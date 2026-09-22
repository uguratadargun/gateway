# Dashboard

## Summary

The dashboard is the one place a person runs their gate from. Connect Claude
logins and other providers, decide how prompts are routed, issue a key to each
person who may connect, watch traffic and what it cost, start a run and follow
it step by step, read what the team remembers, edit the agents, skills and
pipelines the runs use, and try a prompt against the whole thing. Everything
the product does that is not a request passing through or a run on someone
else's machine is done here, behind one secret.

## How it works

### Getting in

One secret guards the whole surface. Signing in exchanges it for an HMAC-signed
HttpOnly cookie good for thirty days; every later request is checked before any
page or management route runs. With no secret configured the admin surface
refuses to serve at all rather than serving unguarded. A browser without the
cookie is sent to the sign-in page carrying where it was going, so signing in
lands on the page that was asked for; a management call without it is refused
outright rather than redirected. Behind a reverse proxy the redirect keeps the
public address, never the loopback one the server listens on. Two surfaces sit
outside this boundary because there is no browser on the other end: the gateway
and the client API, both of which take keys (`teams-and-keys.md`). There are no
roles: one secret, one person, everything. A team chosen on a page scopes which
definitions are shown, never what may be done.

### The shape

A left rail is the whole map — thirteen destinations, no top bar, and a theme
control fixed in the corner so it does not move between pages. Light, dark and
follow-the-system are three buttons, and the choice is applied before the first
paint, so no load flashes the wrong theme.

### A panel's shape, and where its Save is

Every panel is a card, and every card has the same head: an icon, a title, a
line saying what it is for. The headings that group them belong to the page, so
a panel never carries one of its own and every heading on a surface is the same
shape.

A card that can be edited owns a named set of keys and ends in a Save of its
own — in its own footer, under the controls it writes, disabled until something
differs from what was loaded. It PUTs those keys alone; the routing and settings
endpoints both merge a patch key by key, so a card never writes a field it does
not render, and one panel cannot put back a stale copy of another's. A write
that fails says so next to the button rather than flashing "Saved" regardless.
The home page carries one such card for the model behind each tier, six for
settings, and one for account rotation.

### Where a panel's rules live

A panel here is a view onto a feature, and the rules belong to the feature, not
to this page. The home page is the gateway itself (`account-pool.md`,
`providers.md`, `routing.md`); traffic, analytics and sessions are what already
went through it (`gateway-pipeline.md`); executions are runs and their steps
(`executions.md`, `dev-workflow.md`); workflows, agents and skills are the
definitions a run uses (`workflows-engine.md`, `agents-and-skills.md`); and
repos, team, memory and tasks are the rest (`workspaces.md`,
`teams-and-keys.md`, `telegram.md`, `memory.md`). The playground sends its
prompt through the gateway exactly as any client would, so what it shows is
what a real client would get.

### Live updates

Gate is one process, so live updates arrive over two in-process buses and no
broker. Gateway requests publish to an activity feed with a short replay;
`/traffic`'s live tab tails it, over an in-browser window of the last 40
events that is lost on restart. The same page's log tab reads the on-disk
request/response history instead — what was actually served, kept up to
5,000 rows — and one filter bar above both tabs (person, served-by, tier, a
request id) narrows whichever is showing: the live tab drops non-matching
events from its own buffer, the log tab asks the database again. The log
tab's heading says what it does not hold — a cache hit, a refusal, or a
proxied `/v1/models`, `count_tokens` or `batches/*` call — since none of
those write a row (`gateway-pipeline.md`). A row that is there names the run
it was made for and links to it, and its own request id copies out of the
expanded detail and back into the filter to find the same row again. Run
events publish per execution and are buffered, so a page opened mid-run still
renders the path already taken. The execution page
opens its stream only while a run is running and closes it the moment the run
settles; it marks nodes and edges as they fire, shows a step that has started
but has no record yet using the engine's own clock, and re-reads the run's row
on each completion rather than deriving state from events. Panels with no
events behind them poll on a timer. Nothing on this surface decides anything: a
Stop button asks, and the run settles itself.

### What it must never show

Sealed secrets are never returned. Stored logins, provider keys and the bot
token are encrypted blobs; the API says whether one is set and nothing more, so
no panel can render one and no screenshot can leak one. A gateway key and a
person's connect token are plaintext exactly once, in the answer to the call
that created them, shown next to the line meant to be sent — reload the page
and they are gone for good. Forgetting a memory record is possible only from
here: no key, agent or run can delete one. The traffic log and its export are
the one place on this surface that carries people's names and email addresses,
for up to 5,000 requests now rather than 500 — not secrets, but the reason
that page and that download stay behind the cookie.

## Key files

- `src/middleware.ts` — the admin boundary: what is guarded, what is exempt, where an unauthenticated caller goes
- `src/lib/admin-auth.ts` — the session cookie: minting, expiry, constant-time checks
- `src/app/login/page.tsx` — the one form outside the boundary
- `src/app/layout.tsx` — the shell: rail, theme applied before first paint
- `src/components/sidebar.tsx` — the map of the surface, and sign-out
- `src/app/page.tsx` — the home page, composed of the gateway panels
- `src/lib/activity.ts` — the gateway activity feed the live tail reads
- `src/events/bus.ts` — run events with their per-execution replay buffer
- `src/app/executions/[id]/page.tsx` — the live run: stream, graph, steps, stop
- `src/components/workflow-graph.tsx` — the canvas, shared by the definition and execution views; it renders, never routes
- `src/components/save-row.tsx` — the footer an editable card ends in: the dirty-aware Save and the error a failed write returned
- `src/components/ui/` — the shared primitives everything is built from; colours come from CSS variables, both schemes

## Pitfalls

- A page is not a permission boundary: anyone with the admin secret has every page, including keys, secrets and delete.
- The buses are in memory. A restart loses the tail and the replay buffers; the database still has the runs, the live feed does not come back.
- A stream is opened only for a run that is running. A run that settles while the page is open stops updating by design, not by failure.
- Editors pass a half-finished definition through on purpose: the file is re-parsed on save, so the error shown is the real one and an invalid edit is refused at the server, not in the form.
- A key or connect token not copied from the panel that issued it cannot be recovered — issue another one.
- A control added to a card whose key is not in that card's owned set will appear to save and not persist: the card PUTs its declared keys, nothing more.

## Decisions

- [0013 — A card saves what it shows](../decisions/0013-a-card-saves-what-it-shows.md)
- [0011 — Three auth surfaces, three rules](../decisions/0011-three-auth-surfaces-three-rules.md)
- [0010 — Forgetting is a person's, and only from the dashboard](../decisions/0010-forgetting-is-a-persons-and-only-from-the-dashboard.md)
