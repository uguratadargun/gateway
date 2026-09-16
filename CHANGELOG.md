# Changelog

## Unreleased

- Every repository keeps its design, decisions and specs as markdown under docs/, the pipeline writes and reviews them, and the recorder reads them from the run's diff.
- A `record` node after the verifier checks that the run wrote its spec, in dev and dev-quick, and sends the implementer back with what to write when it did not.
- A quick change writes a short spec of its own: the task as given and what was done.
- `npm run changelog:release` moves what is under Unreleased into a heading for the version being released, and the CLI build warns when the version has no entry.

## 0.37.0 — 2026-09-15

Publication targets, pinned run definitions and `gate ask` — the three
pieces a team needs to answer a question about a repository nobody on that
team is sitting in front of. The CLI bundle is rebuilt: the version the
server serves and the version the plugin installs have to be the same
number, or an update reaches nobody.

- feat(ask): one team asks another what its code does, answered from one commit
- feat(runs): the work gets published, and the run is judged by what it started with
- docs: the note the plan was cut from, kept for its reasons
- feat(memory): a path means what it means in the repository it is in
- feat(repos): a repository gets the one name all its clones agree on
- feat(ui): the work has a page, and it leads with what is still unsettled
- fix(executions): a dropped objection says so instead of going quiet
- docs: the cross-team plan the work is being cut from
- feat(workflow): a planner that cannot live with another team's decision says so
- feat(orchestration): the work gets a name that outlives the runs serving it
- feat(memory): a run's own page shows the objections it raised and the answers it holds

## 0.36.2 — 2026-09-15

- a team learns when another team cannot live with its decision
- fix(memory): a decision says what actually happened to it, not "shipped"
- fix(memory): a run may only close its own team's decision
- fix(cli): `--input a=1 --input b=2` keeps both pairs
- docs(teach): name the account's field limits, and what to cut first

## 0.36.1 — 2026-09-15

- `--input` splits on a space, not a NUL byte
- gate: memory can be forgotten — a decision, a run's record, a feature
- docs: a Turkish guide to the dev workflow and memory
- fix(memory): name a cut-off recorder answer, and give it room to finish

## 0.36.0 — 2026-09-14

- /gate:teach records a task finished before gate, from its branch
- fix: preserve public host in reverse-proxy redirects
- gate: questions, approvals and new runs from Telegram

## 0.35.0 — 2026-09-13

- a cockpit can run a session on the gate server
- gate: a run's worktree goes when the run ends, and its branch keeps the work
- gate: a busy account is still asked about its usage, so the per-model weekly limit stays true
- gate: a test run sweeps the temp directories it made

## 0.34.0 — 2026-09-11

- a run is its person's on the client API, a person's node says what kind of turn it is, and the session's state is written for a cockpit
- gate: a connection from the environment stays out of the saved login
- gate: a cache write is priced as a cache write, not as input

## 0.33.0 — 2026-09-11

- memory finds by meaning, the blame road says how sure it is, and a team's page is rewritten from all its decisions
- gate: a node's input usage counts the tokens that went into the prompt cache
- gate: the catalogue entry gets a line of its own, and the recorder's input counts what the cache served

## 0.32.0 — 2026-09-11

- memory: what a run decided is recorded, and the next run reads it before planning

## 0.31.1 — 2026-09-10

- a bounded request from the person goes to the implementer, and no commit is signed

## 0.31.0 — 2026-09-10

- the subagent writes its own answer file, and a node's next pass continues it

## 0.30.2 — 2026-09-10

- a clean JSON answer is taken whole before any fence heuristic

## 0.30.1 — 2026-09-10

- /gate:run picks the road when the user names no workflow
- gate: the implementer reads its ledger from the branch's own log, which needs no base commit

## 0.30.0 — 2026-09-10

- dev runs without skills; the superpowers method moves to dev-super

## 0.29.1 — 2026-09-09

- ending the turn is how a subagent's result arrives, and the note says so

## 0.29.0 — 2026-09-09

- dev-quick, a planner that only plans, and subagents that do not sleep
- accounts: every window an account reports, named the way /usage names it
- gate: the plugin's marketplace source is a setting, so a team installs from its own git host
- gate: the Team page says where the plugin comes from
- gate: a graph laid out by its longest road, with shortcuts drawn over the cards
- gate: cost only the steps the session did itself, and anchor debugging on a phrase

## 0.28.0 — 2026-09-09

- the dev pipeline as a practice, not a sketch

## 0.27.0 — 2026-09-09

- the person's time is not the run's, and Stop stops

## 0.26.4 — 2026-09-09

- a plan is approved once

## 0.26.3 — 2026-09-09

- logging in is joining: login puts Claude Code on the gateway, reset takes it out

## 0.26.2 — 2026-09-09

- gate live silences the connectors notice it causes

## 0.26.1 — 2026-09-09

- /gate:live puts a repository's Claude Code on the gateway with nothing typed

## 0.26.0 — 2026-09-09

- a node in its own model, live in the terminal as the session's subagent

## 0.25.6 — 2026-09-09

- the worker's log reads like Claude Code's own activity lines

## 0.25.5 — 2026-09-09

- defaults:restore names what an update left behind, and --refresh rewrites it

## 0.25.4 — 2026-09-09

- an unattended node asks through the pipeline before it decides

## 0.25.3 — 2026-09-09

- the worker's log reads like the work, and the session shows it whole
- gate: tidy up keeps the cards off the return paths

## 0.25.2 — 2026-09-09

- a question is not a failure

## 0.25.1 — 2026-09-09

- the planner's questions go to the person, and the plan is approved before anything is built

## 0.25.0 — 2026-09-08

- a session-driven run honours the agent's model
- gate: the acceptance gate writes a message, not a menu

## 0.24.3 — 2026-09-08

- the person tries the branch before a merge request is opened

## 0.24.2 — 2026-09-08

- providers, not just local models
- gate: use glab only when it is signed in
- gate: a team that inherits the shipped definitions is not missing them

## 0.24.1 — 2026-09-08

- tell a node when nobody is listening, instead of letting it guess

## 0.24.0 — 2026-09-08

- a default team written against what its skills actually do
- gate: a way to get the shipped definitions back

## 0.23.0 — 2026-09-08

- a default team that works anywhere, and a design that builds on it

## 0.22.0 — 2026-09-08

- a node's skills reach the session that runs it
- gate: settle the brief before starting the run

## 0.20.0 — 2026-09-08

- restate the contract with every node

## 0.19.0 — 2026-09-08

- let a run use the tools the work needs, and ask

## 0.18.0 — 2026-09-08

- say a node has started when it starts

## 0.17.0 — 2026-09-08

- a warning for the version that did not move
- gate: say when a headless run is the wrong command for where you are
- gate: the run happens in your session, not beside it

## 0.15.0 — 2026-09-08

- /gate:update, and a version to check it against
- gate: reset is a machine, not a team
- gate: refuse before asking, and say when the answer was not gate

## 0.14.0 — 2026-09-08

- because an update nobody receives is not an update
