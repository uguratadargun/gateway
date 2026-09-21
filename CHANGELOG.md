# Changelog

## Unreleased

- An agent that answers an optional field with `null` is no longer refused. A `?` in an output schema means "say something only if there is something to say", and a model handed the key list writes all of them and spells the empty one `null` — which was rejected at the last gate, after the work, throwing away a finished verification. `null`, absent and `undefined` are now one answer on a `?` field; a field without one still refuses `null`. The six places the notation is explained say so in the same words.

- A node's second pass is sent only what changed. The subagent that did the first pass still holds the worktree it read and the reasoning it did, and it was being handed its whole brief again — thousands of tokens it already had, which a model reads as an instruction to start the node over. gate now rebuilds the node's inputs as they stood at the previous visit, compares them to the inputs now, and sends the ones that differ under their own headings. `gate next <execution-id> --full` gives back the whole prompt, which is what to do when the subagent is gone.

- The reviewer is no longer handed the whole diff as text. The `diff` node takes `--stat` — enough to say whether anything was built and in what shape — and the reviewer runs its own `git diff` in the worktree it is already sitting in.

- `dev-auto` can stop at the commit. Start it with the run input `deliver` set to `"branch"` and the run ends on a new `committed` terminal, completed, with the work reviewed and on the branch and the push left to you — where before the only way to prevent a merge request was to break the git remote and read the failure. Left unset, the road is unchanged. `not-shipped` now says what is true when it is reached: reviewed and committed on the branch, the push or the merge request failed.

- `/gate:run` no longer tells every node to ask the user. A node whose agent declares no `asks` is written to decide alone — the autonomous road's `decide` is one — and `remember` says which kind each node is. The command file and the `decide` agent were contradicting each other in front of the model.

## 0.42.0 — 2026-09-21

- Connecting a machine no longer needs Claude Code to be working. `/gate:login` is a prompt, so a Claude Code at its weekly limit refused the one command that would have put the person on the team's gateway instead — the way out was behind the account that was out of quota. The plugin now writes a `gate` command to `~/.local/bin` on every session start, and a key is handed out as two lines: the slash command, and `~/.local/bin/gate login <token>` for a terminal with Claude Code closed. Logging in spends no model call, so a spent limit cannot stop it. Logging in again also keeps this machine's workflow approvals and repository paths, which it used to drop.

- `dev-auto`, a shipped road with nobody in the loop: `dev`'s plan, build, verify and review, with the planner's questions answered by the run itself — a new shipped `decide` agent rules from the planner's recommendation and the repository's record, and every ruling is written into the plan's assumptions — no plan review, no acceptance, and the reviewer's approval opens the merge request. A planner still asking after three rounds ends on `never-planned`; one that objects to another team's decision stops, since only a person raises an objection. A test holds its graph to `dev`'s, node by node, since it is written out rather than derived. Never picked on your behalf; `/gate:run dev-auto …` names it. `npm run defaults:restore` on a live gate writes the new agent and workflow.

- The shipped pipelines open a pull request on GitHub. `dev`, `dev-super` and `dev-quick` knew only GitLab — `glab`, or push options GitHub does not implement — so a run in a GitHub repository ended with its branch pushed and nothing opened. The remote's host now picks the route: `gh pr create` for GitHub, glab or push options for everything else. A GitHub remote on a machine whose `gh` is not signed in ends the run saying exactly that. Run `npm run defaults:restore -- --refresh` on a live gate to take the new workflows.

- A workflow run on a gate that has issued keys gets through its own gateway: a node handed to Claude Code is now given a credential minted for that run, where before it arrived as an unauthenticated caller and died on its first request with nothing spent and nothing said. What such a node spends is filed against the run's own person and team, and its calls stay on the machine rather than going out by the public address and back in. When a node does fail, the run says why in the child's own words — not logged in, a credit balance, whatever it was — instead of only that it did not finish.

- A session on the gate server starts in auto mode, like one in the cockpit does: nobody is sitting at that terminal, so a run started there no longer stops on every read, write and command as its own approval. What auto mode will not decide is still held for the person in their cockpit, and Shift+Tab changes the mode for that session.

- Remote sessions start again on a gate running a production build: the cockpit refused them with `node-pty is not installed` on servers where it was installed and working, because the bundled server code lost the function it loads native modules with. The terminal is now reached the way the bundler cannot rewrite, and a gate that genuinely lacks `node-pty` still says so.

- A model's weekly limit blocks that model, not the account: a spent `seven_day_fable` no longer parks the whole login for eight hours while its session window is fine — the model is blocked on that account until the window resets, the login keeps serving everything else, and the pool's 429 names the real reason for each account instead of blaming the throttle. The quota floor reads the account-wide windows only, so a spent model week no longer idles a login for every other model before a request is even sent.

- A review that rejects a change only over its documents no longer costs a full round of the pipeline. The reviewer says so, a new `record-fix` agent rewrites the paragraph, the changelog line or the design sentence, and the diff goes straight back to review — no rebuild, no re-verification. Measured on the run this came from: three documentation sentences cost three fifty-minute laps and then ended the run as failed with every code defect already fixed. A record still wrong after two passes now ends on a terminal that says the code was accepted and the writing was not, and the reviews a change has left are no longer spent by the record rounds.

- A run that hands a step back with a subagent's type name instead of its agent id is refused, with a message saying where the id comes from. Passing the `gate-<team>-<agent>` name was accepted and recorded, and resolved to nobody: every pass of that node started a subagent from nothing and read the worktree again. Measured on one run, a node's tree read the same plan file fourteen times across passes that were meant to be one conversation.

- A node run by Claude Code, and any subagent it starts, is now told what a dispatch and a file read cost on this machine: no command whose only purpose is to let time pass, no subagent type that copies its own context — four dispatches became sixteen that way — every subagent it started named and accounted for before it answers, and files read with Read rather than through the shell, which does not count as read and leaves the next edit refused.

## 0.40.0 — 2026-09-17

- The accounts card keeps itself current: the windows are re-read every fifteen seconds, so usage moves while you watch instead of only when you reload the page, and a rotation setting you are part-way through editing is left alone. The "weekly limit incl. extra usage" bar is gone — Claude sent it for some accounts and not others, and it said what the weekly limit beside it already said.

- The models your providers serve are in Claude Code's `/model` picker, under their own names: `glm-5.3-flash (zai)` picks GLM, `Qwen3.8-27B (vllm)` picks the box on your network, and the gate is asked for exactly the model the row says. Connecting a machine also lets Claude Code read the gate's model list for itself, so the connected account's own models are listed by the gate that will serve them. Until now a connected provider was invisible to everyone but the person who configured it.

- The Traffic page says who made each request, which model answered and which Claude account served it: the person behind the key by name, and the account by its label rather than its id. A request a provider answered names the provider instead, a workflow calling in-process names itself, and a person or account deleted since leaves the row readable rather than blank. The team, the key and the name the client originally asked for are in the expanded detail.
- gate serves the model you name and no longer picks one for you: the difficulty table, the Haiku grader, sticky sessions and the throttle's tier downgrade are gone, because moving a live conversation between models rebuilds its prompt cache and costs more than it saves.
- `model: "auto"` is refused with a message saying what to send instead; re-running `/gate:login` clears the setting from a machine connected before this release, and Claude Code now keeps whatever model you chose with `/model`.
- The routing section of the dashboard is one card: which model each tier points at.
- Reasoning effort is the one cost lever gate still turns, and a client that sets its own is still never overridden.
- Forgetting a repository removes the checkout gate cloned for it, so connecting the same repository again works instead of failing on a directory nothing claimed; a checkout you pointed a path at is never touched, and one a run's worktree still branches from is kept, with the worktrees holding it named.
- A repository says whose it is on the Repos page — at connect time and on the record afterwards — which is what decides whose `gate:ask` may read it; an owner naming no team is refused instead of stored.
- The dashboard is one shape: every panel is a card with the same head, the headings that group them belong to the page, and an editable card ends in its own Save — under the controls it writes, disabled until something changed, and saving only the keys that card shows.
- Saving a settings card no longer puts back the account rotation another panel had changed.
- An Objections page: what stands against your team, what your team raised, and what two other teams in your tree are disagreeing about — the same rows recall shows a planner, found by team instead of by the files you happen to be working in. Until now a team that did not plan in those files never learned anybody had objected.
- A branch that is not finished can be taught, and says so: `gate teach --wip` records its decisions as `in-progress`, and the planner on another team that finds one is told to raise an objection now rather than build on a choice still moving. Teach the branch again once it lands and it stops reading that way. Before this, teaching a seventy-percent branch told every other team it had shipped.
- An objection between teams can finally be closed: the team whose decision was objected to resolves it with a note saying what was done, the team that raised it withdraws it, and neither can do the other's. Both are on the task page, and a closed objection leaves both teams' planners alone — until now a confirmed one stood in their recall forever.
- A session run and a taught branch can name the cross-team task they serve, the way a headless run already could: `gate begin --task-id`, `gate teach --task-id`, and `/gate:run` and `/gate:teach` pass on the one the user names. A branch taught before the task existed is what usually fills it in, so teaching the same branch again takes the task the first teaching did not name.

## 0.38.0 — 2026-09-16

- Every repository keeps its design, decisions and specs as markdown under docs/, the pipeline writes and reviews them, and the recorder reads them from the run's diff.
- A `record` node after the verifier checks that the run wrote its spec, in dev and dev-quick, and sends the implementer back with what to write when it did not.
- A quick change writes a short spec of its own: the task as given and what was done.
- `npm run changelog:release` moves what is under Unreleased into a heading for the version being released, and the CLI build warns when the version has no entry.
- `/gate:init` sets a repository up: it reads the code, writes the architecture, a design doc per key part and the decisions the code and the history show, adds CLAUDE.md and the skeleton, and teaches each feature to the team's memory, one commit and one teach apiece.

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
