# Glossary

This page lists one name for each thing gate has. The name is the one the
record uses; where the code names the thing otherwise, the entry says so.
*Not* lists the other names the record has used for the same thing; do not
write them. An entry without *Not* has no other name in use. This page
renames nothing in the code. A document moves to these names when its
feature is next changed.

**admin secret** — The secret in `GATE_ADMIN_SECRET` that opens the dashboard.

**admin session** — The signed HttpOnly cookie `gate_admin` that the dashboard and the `/api/*` management routes require.

**agent** — One role in a workflow, written as a Markdown file with YAML frontmatter and a prompt. The prompt carries the agent's whole method. *Not:* role, reasoning worker.

**ask** — One team's question about another team's code. The server answers it from one fixed commit of that team's published branch. `gate ask` and `/gate:ask` start one, and the `asks` table keeps it. *Not:* cross-team question, question.

**`asks`** — The agent frontmatter field that puts a node in front of the person. `question` wants an answer in the person's words. `approval` wants a yes or a change. `person` is the older spelling of `question`. This field is not an ask.

**brief** — The text recall writes for the planner before a run plans. *Not:* briefing.

**bundle** — The response of `GET /api/v1/bundle`: a team's definitions in one download. The built `plugins/gate/scripts/gate.mjs` is the bundled `gate` CLI, not a bundle.

**checkout** — The server's own clone of a connected repository. The record index and asks read it. *Not:* working copy.

**Claude login** — A person's own Claude Code sign-in. Every model call of a run uses it. *Not:* Claude account, subscription.

**client API** — The server routes under `/api/v1/*`. The `gate` CLI calls them with a key.

**clone** — A person's own git clone of a repository on their machine. `gate repo <id> <path>` tells gate which clone belongs to which repository. *Not:* checkout, working copy.

**command node** — A node with `type: command`. The `gate` CLI spawns it from the argv array in the workflow, never from a shell string.

**condition** — The `when` expression on an edge. The walk parses it and interprets it; nothing evaluates it as code. A node with `type: condition` is a condition node.

**connect token** — The one string `gate login <token>` takes. It wraps the server's URL and a key, and starts with `gatec_`. The dashboard shows it when it issues a key. *Not:* token, connection token.

**consolidation** — A pass over every decision under one feature for one team. It rewrites the feature implementation whole and closes the decisions a later one replaced. It runs on the recorder's provider model after every `memory.consolidateEvery` new decisions.

**cross-team task** — Work that several teams in a team tree share. A person opens it with an owning team and a title, and every run that serves it carries its `--task-id`. The Tasks page lists them, and the code keeps them as `ChangeTask` in `change_tasks`. *Not:* change task.

**dashboard** — The web interface of the server, behind the admin session. Its first page is also titled "Dashboard". *Not:* the UI.

**decision** — One choice a run made, as the recorder writes it into memory: what was decided, why, how, and the files it touched. It is a row of `memory_decisions`. *Not:* memory record, memory entry, record.

**decision record** — A file `docs/decisions/NNNN-<slug>.md` in a repository. The record index reads it, and recall cites it. *Not:* ADR.

**default team** — The team `default`. A server with one person and no teams uses it.

**definitions** — A team's agents and workflows, as files under `~/.gate/teams/<team>/` on the server.

**design doc** — A file `docs/design/<feature>.md` that says how one feature works today. Its file name is the feature's id across the team tree. *Not:* design document, feature's page.

**dev workflow** — The shipped workflow `dev`: recall, plan, approve, implement, verify, review, try, merge request. `dev-quick` and `dev-auto` are other shipped workflows. *Not:* the pipeline, road.

**edge** — A link from one node to the next in a workflow, with an optional `when` condition. *Not:* transition, link.

**executor** — The agent frontmatter field that says who does an agent node. With `executor: gate`, the person's session does the node itself, in front of the person. With `executor: claude-code`, a subagent of the session does it, on the agent's own model. *Not:* gate-executor, gate's own executor.

**fallback edge** — The last edge of a node that has no `when`. The walk takes it when no condition holds.

**feature** — A thing the product does, with one name across the team tree. It is a row of `memory_features`. A design doc's file name is its id.

**feature catalogue** — The list of a team tree's features, with their other names. `gate memory features` prints it, and the Memory page shows it as "Catalogue".

**feature implementation** — One team's summary of how it built one feature, with its pitfalls. It is a row of `memory_feature_impls`. *Not:* implementation summary.

**`gate` CLI** — The command-line program in the plugin. A session calls it to drive a run: `gate begin`, `gate next`, `gate step`.

**give-up edge** — An edge whose `when` counts visits or failures. It leads to a terminal that says what is stuck. Every loop in a shipped workflow ends on one.

**key** — A credential the dashboard issues to one person on one team. It starts with `gate_`, and the `apikeys` table keeps its hash. A revoked key stops working on the next request. A provider's credential is its API key. *Not:* API key, personal key, issued key, token.

**memory** — What a team tree has recorded: decisions, features, feature implementations and objections. The server keeps it in its database, and recall searches it.

**merge request** — The request to merge a run's branch into its base branch. The `merge-request` node opens it. *Not:* pull request, PR, MR.

**mirror** — A machine's copy of its team's definitions, under `~/.gate/cache/<team>/`. `gate pull` makes it match the server. The code's names for it are `cacheDir` and `cacheScope`. *Not:* cache.

**node** — One vertex of a workflow: `agent`, `command`, `condition`, `parallel` or `terminal`. *Not:* step.

**objection** — A run's statement that a decision another team recorded conflicts with its work. The planner's `conflicts` output carries it, and the `conflict-review` node puts it to the person. The team it stands against resolves it, and the team that raised it withdraws it. The code keeps it in `decision_issues` and serves it at `/api/issues`. *Not:* issue, conflict.

**person** — Someone who uses gate. A person holds one key and is on one team. The code keeps people in the `users` table and serves them at `/api/users`. *Not:* user.

**pin** — The copy of the definitions a run takes when it begins. A later edit to a definition does not change a run that has its pin. The code keeps it as `PinnedDefinitions` in `definitions_json`. *Not:* snapshot.

**plan** — The planner's working file under `docs/plans/`. A spec is the final plan, copied when the run's last task is committed.

**plan task** — One `### Task N:` section of a plan: the files, what to do, the test and when it is done. The implementer commits each plan task on its own. *Not:* task.

**plugin** — The Claude Code plugin under `plugins/gate/`: the `/gate:*` commands, the SessionStart hook and the bundled `gate` CLI.

**provider** — A model endpoint the server calls itself. The recorder, consolidation and the embeddings use one. *Not:* endpoint, model provider.

**provider model** — A model on a provider, written `provider:<name>/<model>`. The server still reads the older form `local:<name>/<model>`. *Not:* local model.

**publish** — To push a run's branch to its repository's publication remote. `gate publish <execution-id>` does it, and so does the end of a run. `gate push` is something else: it saves definitions to the team. *Not:* push.

**recall** — The agent and node that search memory and the record index before a run plans. Recall writes the brief.

**record** — A repository's own written account of itself: `docs/ARCHITECTURE.md`, design docs, decision records, specs, `CHANGELOG.md` and `docs/GLOSSARY.md`. Memory indexes the record and does not replace it. Memory's rows are decisions, and what a run did is its steps.

**record index** — The server's read of every connected repository's record from its base branch. The tables `record_repos`, `record_docs` and `record_interfaces` hold it.

**`record` node** — The command node in the dev workflow after the verifier. It checks that the branch has its spec and that no decision record the branch added takes a number the base branch already holds.

**recorder** — The server-side pass that reads a finished run and writes its decisions into memory, on a provider model. The `memory_extractions` table holds one row for each run it records. *Not:* memory recorder, extraction.

**repository** — A git project connected to the server once: its one name, the server's checkout, and the remote finished branches go to. The `repos` table keeps it, and the dashboard lists it on the Repos page. *Not:* repo, project.

**run** — One walk of a workflow for one task, driven from one person's session. The code, its routes and the Executions page call it an execution: `workflow_executions`, `<execution-id>`. *Not:* execution.

**server** — One running gate: the dashboard, the client API and the database, on one host. "gate" is the product's name, and `gate` is an `executor` value. *Not:* the gate, this gate, gateway.

**session** — A person's Claude Code session. A run happens only in one. The dashboard's cookie is the admin session, not a session. *Not:* conversation.

**spec** — A file `docs/specs/YYYY-MM-DD-<topic>.md` that says what one item set out to do and what counted as done.

**step** — One visit of a run to a node, as the server records it: what the node was handed, what it answered, and the edge that followed. It is a row of `workflow_execution_steps`. *Not:* pass, round, attempt.

**subagent** — The Claude Code subagent that an `executor: claude-code` node runs as, of type `gate-<team>-<agent>`. An agent is the definition, and a subagent is one running instance of it.

**task** — The sentence a run is given: `gate begin <workflow> [task…]`, read by agents as `input.task`. A cross-team task and a plan task are other things.

**teach** — To record a branch that was finished before gate recorded runs. `gate teach` and `/gate:teach` do it through a `gate:teach` run and the recorder.

**team** — A group of people that owns one set of definitions. Every key belongs to one team.

**team tree** — A root team and every team under it. Memory search, asks and objections stay inside one team tree. In the code, `teamFamily` returns the whole team tree, `teamTree` returns the teams under one team, and the root is `teamRoot` or `org_id`. *Not:* family, org.

**terminal** — A node with `type: terminal`. It ends a run with `status: completed` or `status: failed`.

**visit** — The number of times a run has entered one node. A condition reads it as `visits.<node>`.

**walk** — The code that replays a run's steps to find the run's next node (`nextInSession`). The walk takes the first edge whose condition holds.

**workflow** — A YAML graph of nodes and edges. A team writes it once and runs it on any task. "A team's development pipeline" describes the product, not a workflow. *Not:* pipeline, road.

**`workspace`** — The workflow block that gives each run its own worktree: `repo`, `baseRef` and `branchPrefix`.

**worktree** — The git worktree a run works in, on the run's own branch, on the person's machine. `gate clean` removes the ones finished runs left. The code calls it a workspace: `RunWorkspace`, `~/.gate/workspaces/`. *Not:* workspace, for the directory; a workflow's `workspace` block is its own entry.
