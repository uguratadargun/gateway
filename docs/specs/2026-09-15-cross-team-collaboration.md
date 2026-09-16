Status: in progress
Branch: main
Decisions: docs/decisions/0002-objection-record-instead-of-messaging.md, docs/decisions/0003-ask-answers-from-one-commit.md
Design: docs/design/memory.md
History: document version 7, reviewed at checkout 2f50e4e; translated from docs/multi-project-plan.md

# Gate — Shared planning and execution across projects

**Document version: 7 — a small first package and an explicit authority boundary**
Date: 15 September 2026
Status: an implementation plan based on code review; the feature is not implemented.
Reviewed checkout: `2f50e4e`. Superpowers was not used.

This document merges the earlier revision notes into one plan. The five packages below are the current delivery order; the old A–G order is not used.

## 1. Goal

The desktop, iOS, mobile and server projects must be able to work on one target. When work has progressed in one project, the others must see that work with its sources, contribute from the same starting information, and one final plan must result. Implementation is done with a separate run per project; dependencies and outcomes are tracked on the shared task.

The verified work of the project that is ahead is preserved. Incompatible decisions enter the plan as revisions with a stated reason. That a project started first does not mean all of its decisions are right.

The first delivery also fixes the loss experienced today: the server team objects to a desktop decision, the person confirms, and desktop sees the open objection at its next recall. Running the four repositories on the server is not needed for this.

The scope is the development of the Gate product. The real changes in the four product repositories and the live Gate database were not reviewed. Repository addresses, publication targets and working machines will be mapped at setup.

## 2. Current state, verified from the code

| Area | Current state | Change needed |
| --- | --- | --- |
| Team / memory | `src/lib/teams.ts`, `src/memory/`: hierarchy, family search, feature catalogue and recorder exist | The existing base will be used |
| Recall | `src/workflows/defaults.ts`, `src/memory/access.ts`, `cards.ts`: carries memory into the plan input | Open objections added to every read path |
| Local step recording | `src/app/api/v1/executions/[id]/events/route.ts`: writes steps with `recordStep` | Atomic, retry-safe objection recording |
| Step replay | `src/executions/store.ts`: `ON CONFLICT(execution_id, step_index) DO NOTHING`; return type `void` | Return whether a row was newly inserted |
| Transaction | The events route writes steps one by one; no wrapping transaction | Step and the derived objection commit or roll back together |
| Output validation | `src/lib/client-api-schemas.ts`: `step.output` is currently `unknown` | Objection and confirmation fields validated separately on the server |
| Human question | `src/client/step.ts`: `asks !== undefined && executor === "gate"` | The existing session question/answer flow will be used |
| Repository | `src/repos/store.ts`: URL / local path and setup exist; no team relation | Identity, access and publication target added |
| Source | A decision has base/head commit; no repoId | Sources defined together with the repository |
| Execution | One worktree per run; engine parallel uses the same workspace; session branches run in sequence | Separate execution per project and a shared-task relation |
| Continuation | `resumedFrom` is the existing run continuation chain | Not reused for the shared task / child relation |

Verified bugs and limits:

- `replaceDecisions` does not stop a decision from closing another team's decision with `supersedes`; there is no ownership check.
- `outcomeOf` counts some completed runs, or a successful PR-opening step, as `shipped`. That is not evidence of a merge or a deploy.
- `replaceDecisions` deletes decisions and generates new IDs on re-extraction. The existence of an objection must not depend on that ID.
- `parseArgs` joins repeated `--input` values with NUL; `parseInputs` splits on a space. The repeated form is broken. `2013a0f` did not fix this completely; verified by running the current parser.
- The finish diff is only the change the finishing run reported; it is not the whole repository's content, nor the current code of a run still going.

## 3. Package 1 — Fix the lost objection and the existing bugs

### 3.1 Task and objection record

A durable task identity and a run–task link are added. Old single-repository runs work as before. An objection is found through the related feature or repository-scoped paths even when there is no task label.

`DecisionIssue`: its own durable ID, the source execution/step, the target team, the repository identity where known, the source commit, feature/paths, a snapshot of the decision content, the reason, the suggestion, the revision, the confirmation source and the status.

The first package does not wait for the full repository inventory: the existing execution/workspace source is stored as an explicit source definition. If the identity is unclear it is not guessed. In Package 2 it is mapped to the canonical repoId with evidence. The same relative file path does not merge decisions in different repositories.

An objection's status goes `proposed → open → resolved/withdrawn`; a refused proposal stays `rejected`. The confirmation notice is a separate durable record carrying the states `pending_source → applied/rejected`. When the source does not yet exist, the confirmation itself is stored rather than opening an objection that does not exist. A new recorder pass cannot delete an objection. The card ID is an auxiliary link; the source snapshot and the objection ID are preserved. Paths/feature are search keys, not the objection's unique identity.

### 3.2 Writing the step and the objection atomically

The session-driven write entry point is the existing `POST /api/v1/executions/[id]/events` route. No new server-side model run is required.

1. The report's identity/authority and structure are validated. Package 1 uses the server's versioned, fixed objection/confirmation protocol schema; a workflow bundle snapshot is not mandatory. The execution must belong to the caller, the source must be a recorded step in the same run, and the target team must be within the family the server computes for the caller. The `conflicts[]` / `resolved[]` fields are validated for type, size and source links. This does not prove the output was really produced by a particular agent; it is a limited authority to send a proposal. The mere presence of a field name cannot change another team's decision or shipped status.
2. `recordStep` is changed to return the SQLite insert result as `inserted: boolean` or `changes`. `ON CONFLICT ... DO NOTHING` is kept.
3. The events route's step loop moves into a shared recording service that uses `BEGIN` / `COMMIT`, and `ROLLBACK` on error, on the same SQLite connection. No model/network call and no `await` inside the transaction.
4. **Only for a new step with `changes > 0`**, the candidate objection or the durable confirmation notice is written for the first time. If the source exists, the confirmation is validated and applied; otherwise it becomes `pending_source`. If the step is written but these records cannot be, the whole transaction is rolled back because of a real database error; on resend they are retried together. A source step that has not arrived yet is not a write error and not grounds for rollback.
5. Extra protection: `UNIQUE(execution_id, step_index, conflict_key)` on the candidate's source, and a unique key on the confirmation notice over the confirming execution/step identity plus source node/visit/conflict_key. So even when the source is not there yet, the same confirmation cannot create a second row. The planner gives each step a unique `conflict_key`, validated by schema.
6. If the same step arrives again, no new objection/transition is produced. If a different output arrives under the same step identity, it is reported as a protocol mismatch; the record is not silently replaced. The confirmation flow does not depend on the events reply returning an identity mapping.
7. Success notices and UI/bus events are published only after commit. A rolled-back objection is not shown as opened in the UI. Existing cost, pause/resume, workspace and heartbeat behaviour is preserved; the transaction boundary of side effects is applied explicitly.

The server engine's `runner.ts` onStep path uses the same atomic recording service; it does not open a second transaction of its own. If objections need to be extracted from past steps, that is an identified backfill job separate from the live re-report notice. Missing historical objections are not re-derived at random just because an old step was not inserted.

### 3.3 How does the conflict identity pass through the question and the answer?

The planner's output has a `conflicts[]` with a defined schema; each item carries a `conflict_key` unique within the step. `walk.ts` takes the previous output into `state.outputs`; `prepareAgentNode` / `resolveInputs` carry it to the next node. The confirming agent declares `planner.conflicts` in its inputs, and `visits.planner` to identify the source visit; workflow node inputs may narrow this declaration, not widen it.

`resolved[]` is added to the asking agent's output schema. Each item carries `sourceNodeId`, `sourceVisit`, `conflict_key`, `decision`. The execution identity comes from the authenticated run/route context. The source visit's number is normalised by the same rule as the existing StepRecord.visit and tested with repeated planner visits. A visit's output is not edited afterwards; a revision is a new source visit/key.

The server finds the source step and the candidate objection by `(executionId, sourceNodeId, sourceVisit, conflict_key)`. It verifies that the source node/visit mapping is unambiguous; an ambiguous record is rejected. It generates and stores its own durable `conflictId`, but the confirmation input does not need to obtain this ID from the server. The UI may read the ID. No new mandatory events reply field, no client-side identity mapping state, and no network wait before the question are added.

The server checks the confirming node's execution/node/visit context, the source step, the reported source relation and the caller's authority. A confirmation is valid only for the current source visit given to that node. A wrong key, an old planner visit or a repeated answer cannot create a new transition. The person's answer reaches the events route as normal node output. Obtaining the real user answer is the responsibility of the existing question mechanism; a model field alone is not evidence of independent human confirmation.

**Report order and durable waiting:** in a report whose schema and authority are valid, when both source and confirmation are present, steps are processed in stepIndex order. If the source has not arrived yet, the confirmation step and the confirmation notice are written as `pending_source` within the same transaction; the other valid steps are also recorded and an HTTP success reply is returned. The whole report is not rejected because of a missing source. The client does not need to split the batch, add a new answer mapping, or tie the question to a network reply.

When the source step arrives, the shared recording service queries the confirmations waiting for this source. It repeats the key, node/visit, source relation, revision and authority checks. A suitable confirmation becomes `applied` and the permitted objection transition happens in the same transaction. An invalid confirmation becomes `rejected` with a reason; neither the source itself nor the other steps are lost. Current states such as the objection being closed/withdrawn are checked; a late confirmation cannot reopen closed work. When several conflicting confirmations exist for the same source, the last does not silently win; the conflict is marked visibly.

Creating a new record is bound to the `changes > 0` condition; **resolving an already durable pending record** is not bound to re-inserting the step. Durable pending records are reconciled when the source arrives, and on server restart / in a bounded maintenance pass. State transitions are atomic through expected-state conditions and unique keys; re-reconciliation does not apply the same confirmation twice. If the source never arrives, the confirmation stays visible as `pending_source`; it is not auto-deleted and not counted as applied. UI/recall distinguish it where needed as "confirmation reported, source step awaited"; it is not presented as an open/verified objection.

This behaviour does not require the reporter to resend the whole batch because of a missing-source error. Authentication, malformed reports and real storage errors keep the existing error path; the "do not reject the report" rule applies only to a valid report's not-yet-arrived source dependency. Publish-after-commit and rollback-on-real-storage-error do not change.

**Delivery reliability boundary:** the existing `RunReporter` holds at most 200 steps in memory and tries at most four rounds during stop. `pending_source` preserves a confirmation that reached the server; it cannot recover a step that never reached the server. The first package's guarantee starts from the records the server has accepted. If end-to-end lossless delivery across a long network outage is wanted as well, a durable local outbox, an acknowledged-delivery mark, batch sizes within the limits and resend after restart must be taken on as separate work in the scope of `src/client/{reporter,api,step}.ts`. This existing transport gap stays visible; this version does not claim to have solved it.

**Package 1 authority boundary:** the authenticated run owner may send an objection proposal to a team within its own family. The person's answer reported by the client may make the proposal `open`; this means only "an open review request". UI/recall state that this is a client-reported confirmation. The target decision's `valid_to`, `supersedes`, validity or shipped status is not changed; the proposal does not count as a verified shared product decision. The sender may withdraw its own proposal; for the resolution record, the server checks target-team ownership or explicit administrator authority. Another team's run's success report cannot close an objection by itself. The family filter is computed not only on read but also when creating a proposal and when applying a pending confirmation.

This boundary accepts the risk of wrong proposals and review noise within a family. Records are shown with their sources/actors; the model does not adopt them as fact automatically. Limits on source and output size/count are enforced. Writing records outside the family, closing another team's decision, or running code on their behalf are not within this authority.

**Definition pinning, moved to Package 2:** comparing the hash of the workflow/agent bundle the client copied with `pinDefinitions` in the run record, and storing an immutable snapshot on the server, exist to validate the schema and the planner–confirmation input binding correctly under changing definitions. A snapshot does not on its own prevent an authorised client from sending fake but schema-conformant output; it is not evidence of independent human confirmation. That is why Package 1's narrow proposal authority does not depend on the snapshot. In Package 2, new runs are bound to the same authoritative definition version; on mismatch a sync is requested. Old runs may report under the Package 1 protocol; they are not shown as having historical definition evidence they do not possess.

The general workflow traversal engine and the existing upstream transfer are preserved. Package 1's work is the agent output/input definitions, the fixed protocol schema, family/ownership checks, atomic recording and the reconciliation of durable pending confirmations. Full workflow/agent snapshot matching is Package 2's work.

### 3.4 Carrying it end to end into recall

Issue store/query → `LocalMemoryAccess.search/feature` → `MemorySearchResult` / `FeatureDetail` → the `cards.ts` text generators → the memory search/feature APIs → client memory access and CLI → runtime memory tools → the recall prompt → planner input.

Open objections may return as a separate field; this does not depend on a deleted memory card entering the results. The execution memory screen shows the same state. The recorder enriches the description; the existence of the objection does not depend on end-of-run extraction. An objection closes only with an authorised resolution record and fix/test evidence; the run completing is not enough on its own.

### 3.5 Independent fixes

Implementation order within the package: first `--input` and its regression test; then the cross-team supersede ownership check and its test; then the atomic objection/confirmation recording with the recall chain. The shipped-status distinction is handled in the same package as independent correctness work.

- Prevent directly superseding another team's decision; use the objection path.
- Distinguish PR opened, merged, deployed, and run merely completed. Do not relabel old `shipped` records without evidence.
- `--input`: fix both supported forms, NUL-separated and space-separated. `split(/[\u0000 ]/)` is a candidate; add tests for repeated/mixed flags, empty separators and `=` inside a value. Separately clarify the syntax for a single value containing spaces. Reproduced and tested with the bundled CLI build.

**Touches:** `src/executions/store.ts`, the events route, `src/executions/runner.ts`, `src/lib/{db,client-api-schemas}.ts`, `src/client/{api,step,cli,memory}.ts`, `src/agents/defaults.ts`, `src/workflows/defaults.ts`, `src/memory/`, the runtime memory tools and the related API/UI paths.

**Acceptance:** the server team's planner produces an objection, the person confirms, the run is cut off; desktop sees the open objection through recall in its next session. A repeated report produces one record. An objection insert failure rolls back the step insert too. A wrong/old confirmation is rejected. A recorder re-run does not lose the objection. Engine and HTTP/CLI paths give the same result.

## 4. Package 2 — Source access, publication target, gate ask, and definition pinning

This package also adds the workflow/agent bundle hash match at run start and the server-side snapshot record. Even if the current definitions change after start, events validation uses the run's snapshot; the node role, the declared output schema and the input binding are validated.

Repository identity and the repository–team relation are added. Reading a family's memory does not count as authority to read repository code or to run workflows in another team. The canonical repoId is carried into executions, decisions, touches, feature implementations and source citations. Where the identity of old records cannot be safely derived from the sources, it stays unknown.

For the requirement of answering when nobody from desktop is at their machine, an accessible `publicationRemote`, a branch policy and the last verified publication commit are mandatory on the repository record. A local run's branch is pushed to this target on finish; work in progress is published through explicit checkpoint commits. Pushing only at the end of a run is not enough to share unfinished work. Push is a publication step separate from the baseline query; no force push. Target and access details are defined at setup.

`gate ask` resolves the requested repository/run/ref to a fixed commit. Memory or a previous answer is used only if it satisfies the question and the requested source version; otherwise an authorised read-only source review is done. The answer states the repository, the commit, file/line, or the decision/run source. Uncommitted and unpublished code does not count as reachable remotely.

If the source is missing, `source_unavailable` is returned with which branch/commit needs to be published; "the feature was not built" is not said. An answer from an older commit is given only with the version stated explicitly. A publication failure does not erase the development result; the publication state waits/fails separately. Four clones on the server are not assumed; the access method is verified on the repository record.

Source reading must be read-only at the tool layer. If the executor cannot guarantee this, a model executor with no write/arbitrary-command tool is used. Tests are a separate isolated verification job.

**Touches:** the run record API/schemas, `src/client/step.ts` definition pinning and bundle transfer, the execution snapshot store, `src/repos/{store,setup}.ts`, `src/lib/{db,tenancy}.ts`, `src/client/`, `src/runtime/tools/`, `src/memory/`, the repository API/UI and the plugin commands. `gate ask` is part of this package.

**Acceptance:** with desktop switched off, a cited answer comes back about a published checkpoint; an unpublished ref gives an explicit access error; no information leaks beyond family/repository authority; the same path does not get mixed up across repositories.

## 5. Package 3 — Four project contributions and one final plan

Flow: select task/projects → review existing progress → baseline v1 → four project contributions → one coordinator draft → four short compatibility reviews → final plan version.

In its first version, the baseline consists of repoId, the selected run/branch, the fixed commit, a cited memory summary, test evidence and open objections. A moving branch name is not enough on its own. Uncommitted work is shown explicitly; to include it, the selected work is committed/checkpointed first. Automatic dirty-snapshot transfer is outside the first version.

Every project receives the same baseline version and reports its done/remaining/revised work. The coordinator is the plan's single author. Every project reviews the first draft; in a later revision only the projects affected by the change are called again. After at most two automatic revision rounds, unresolved product decisions are presented to the user with explicit options. Contribution from all projects is a user requirement; it is not deferred pending a single-planner comparison.

The plan contains shared behaviour, API/data contracts, per-project work, dependencies and acceptance tests. It is not ready while there is an open blocking objection, a missing project review, a differing baseline or a dependency cycle. If the source changes, a new baseline/plan version is created; only the affected proposals and reviews are refreshed.

Example: existing work on desktop is preserved; if the server team finds an incompatibility, the bounded revision desktop needs is added. The other projects adapt the verified desktop behaviour to their own structures. Work already done is not redone once it is verified to meet the acceptance criterion.

**Records:** ChangeTask, TaskProject, Baseline, ProjectProposal, PlanVersion, PlanReview, WorkItem. The Package 1 task/objection records are extended; not all tables are mandatory from the start. Source snapshots preserve the plan's evidence; rebuilding the recorder's whole ID model is not a precondition for the first delivery.

**Touches:** new `src/orchestration/{types,store,baseline,planning,validation}.ts`, the existing agent/workflow definitions, the task API and the shared plan screen/CLI. The new paths are a proposal, not a claim of working modules.

**Acceptance:** four contributions rest on the same baseline and one plan results; the desktop work to be preserved and the required revisions are visible. A review of an old source cannot make a new plan ready.

## 6. Package 4 — Implementation and integration with the existing executors

Every project works in its own session or engine run with `taskId + planVersion + workItemId + baselineRevision`. A separate worktree/branch is used. The existing session parallel node is not used in place of four repository executors. `resumedFrom` stays as the continuation relation; TaskExecution holds the work/run/attempt link separately.

The CLI or UI starts the next work item in the selected project; the server checks authority, the plan version, that dependency outputs are verified, and that no other valid run exists on the same item. There is no automatic central start of different machines yet. Source/work/attempt states are held with SQLite transactions and unique keys.

Every project uses the version/hash of the contract output it needs. Progress and cost are visible on the shared task. Dependants of a failed item wait; independent results are preserved. Continuation does not repeat completed work. When the plan changes, the affected items and their transitive dependants are put back under review; old output is not silently included in the new plan.

Completion: repository tests plus shared contract/integration tests on a fixed output/commit manifest. Four separately passing repository test suites are not evidence of shared compatibility. PR, merge and deploy are held as separate states; an atomic merge across four repositories is not assumed. Decisions and resolved objections are written to memory with their sources.

**Touches:** `src/client/{api,cli,run,step,reporter}.ts`, `src/executions/{runner,store,resume}.ts`, the worktree infrastructure, the task API/UI, new orchestration integration and the memory end-of-run links.

**Acceptance:** an item does not start before its dependency completes; a restart does not produce a duplicate run; failed/continue preserves the running item; the task does not appear complete while a contract test fails.

## 7. Package 5 — Automatic distributed execution

For all projects to be started automatically from one centre on suitable machines: runner registration, capability/host mapping, a durable job queue, dispatch, lease and heartbeat are added. It is not a precondition for Packages 1–3; it is the separate delivery of fully automatic multi-machine execution.

Taking a job and starting a child must be re-invocable; two valid writers must not arise for the same job/version. A late result under an expired lease is rejected. On restart the server reconciles its records; it does not send a second writer to the same repository/job until it is certain the old worker is not running. Loss of connection does not count as success. If no suitable iOS machine exists, the job waits and the reason is visible.

Cancellation stops new dispatch and is passed to running children; it does not erase completed evidence. Cost and parallelism limits are configurable. A long-lived task is a durable record, not a model session open for days. A repository-less coordinator can run with the existing gate model executor; the claude-code executor requires a workspace.

**Touches:** new orchestration scheduler/dispatch/events, runner API/client support, the execution/event infrastructure, the task UI.

**Acceptance:** a restart does not produce duplicate jobs; an old lease cannot change a new plan; an offline host waits; stop/retry preserves independently completed jobs.

## 8. Verification and delivery criteria

Package 1 tests cover in particular:

- Send the same report again: one step, one objection; the durable objection ID does not change.
- Cut the objection insert with an error after the step insert: both roll back; on retry both are created.
- Same step identity, different output: error; the existing record is unchanged.
- Malformed `conflicts[]` / `resolved[]`, wrong node, another conflict, or an old revision: the state does not change.
- Before the events reply arrives, the local asks shows the right objection from the upstream planner output; a retry does not produce a second record.
- The confirmation report arrives before the source step: HTTP success, durable `pending_source`; the other steps in the batch are recorded too. When the source arrives, the confirmation is applied automatically.
- The same pending confirmation is reported again: one row; reconciliation after restart makes the transition once.
- The source never arrives: the pending confirmation stays visible and durable. When the source arrives with a wrong key/revision, it is rejected with a reason; the other records are preserved.
- A real DB error during reconciliation with the source already inserted: atomic rollback; a single transition at the end of a retry or a durable pending sweep.
- A late confirmation does not reopen a closed objection; conflicting answers do not silently override each other.
- An objection proposal outside the family, and an attempt to close another team's decision, are rejected. A schema-conformant client notice does not turn into verified decision/shipped information.
- A source run without target-team authority cannot make an objection resolved; withdrawing its own proposal is a separate authority.
- The planner is visited a second time: an old visit's confirmation cannot open the new objection; the visit number is carried and matched correctly.
- The run is cut off after the human confirmation: desktop recall/CLI/engine/API see the open objection.
- The recorder re-extracts: the objection's source and findability are preserved.
- `--input` repeated, grouped and mixed forms work in source and in the bundled CLI.

Package 2 tests: snapshot validation stays the same even if definitions change after the run starts; in a new run, a hash mismatch and a wrong planner–confirmation input binding are rejected; old runs' restricted protocol behaviour is preserved.

In the other packages: repository identity/authority separation, source access with the machine off, four projects using the same baseline, the effects of a plan revision, dependency checks, restart/lease tests and cross-contract verification.

The existing Vitest infrastructure is used. Related existing tests: local-runs, executions, session-walk, session-continue, resume, worktree-prep, memory-recall, memory-store and tenancy. Targeted tests, typecheck and the related build check are run during implementation. Implementation tests were not run during planning; only the example of the bug in the existing input parser was verified by running it.

Measurements: time to close an open objection, source access success, per-project analysis cost, verified work reused, number of revisions, queue latency and integration result. Performance targets are set with a real pilot.

The earlier design note was kept unchanged as the rationale record; it is now [0002 — Objection record instead of messaging](../decisions/0002-objection-record-instead-of-messaging.md). This document is the current source for implementation.
