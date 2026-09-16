# 0009. A run is judged by the definitions it started with

Status: accepted
Date: 2026-09-16
Run: 5362915

## Context

Another team cannot read work that never left the machine that made it, and cannot trust a report whose definitions moved underneath it. The second half is this record. The client already froze its own copy of a workflow and its agents, so a mid-run edit would not move the graph a run was walking. Nothing, though, fixed what a run's reports were *judged* by: a team editing an agent an hour into someone's run changed what that run's node names meant, in either direction, with nobody able to say which version it had been held to.

## Decision

When a run starts, the server keeps its own copy of the workflow's source and the source of every agent the graph names, hashed, and the run starts only when its hash agrees with the client's. Later reports are checked against that snapshot — a node's role, the output it declared, and which upstream node it may read. An agent the graph names and nobody can read is recorded as missing rather than refusing the run.

## Rationale

The snapshot fixes what a name meant, which is the thing a later reader needs. Without it, "the reviewer approved this" is a claim about an agent definition that may no longer exist in the form that approved it.

Both halves are needed and they are not the same. The client's frozen copy keeps a run walking one graph. The server's copy is what a report is checked against. Either alone leaves one of the two failures open.

What it is not, and this matters: proof that an output came from that agent. A client holding a token can send whatever it likes under a node's name. The snapshot fixes what the name meant, and the narrow powers of the objection protocol are what make that acceptable; they do not depend on it.

Sources, not parsed forms. The same bytes are what the client mirrored, so the hash is over the thing both sides actually have — a parsed form would differ over formatting neither side changed.

Skills are deliberately left out of the hash. A skill changes how well an agent does its work, never what its output means or what it may read, and including them would mismatch a run over a typo fixed in unrelated prose.

A missing agent is kept in the snapshot rather than dropped, so that it is a difference between the two sides and not something they silently agree about. Refusing the run outright was rejected for a plainer reason: the run that most needs its definitions written down would be the one that has none.

## Alternatives

Trust the client's frozen copy alone. The client is the party whose reports are being checked; the copy it froze is not evidence against it.

Hash the parsed workflow and agents rather than their sources. Two sides that mirrored the same bytes would disagree over whitespace or key order, and the mismatch would look like tampering.

Include skills in the hash. Skills change often and for reasons unrelated to what a node means, so runs would mismatch over prose edits.

Refuse a run whose graph names an unreadable agent. It blocks the case where the definitions most need writing down, and turns an editing mistake into a failed run instead of a recorded fact.

Re-read the definitions when a report arrives. That is the failure being fixed: the report would be judged by whatever the definitions say now.

## How it works

`snapshotDefinitions` reads the workflow's YAML and the source of every agent the graph names out of the scope, byte for byte, and hashes them together with the workflow id and a version — agents that could not be read contributing `missing` rather than being left out. The digest is short and order-independent.

The run records that snapshot at its first step. A continued run takes its own, not its parent's, because it walks the graph as it stands when it is continued.

When a report arrives, the node's role, its declared output and its permitted upstream reads are resolved out of the snapshot rather than out of the current definitions. Where the snapshot cannot say — a run that predates this, or one whose snapshot already recorded the agent as missing — the check falls back to the way it always was, rather than failing for missing evidence nobody could have produced.

## Consequences

A run's judgement is reproducible after its definitions have been edited or deleted, and the snapshot is what a cross-team reader is pointed at.

Runs started before this have no snapshot and are checked the old way, permanently. That is visible in the record rather than papered over.

Editing an agent mid-run is safe for runs in flight and changes nothing about how they are judged. It does change the next run, which takes its own snapshot.

A change that makes the snapshot authoritative about *who produced* an output, rather than about what a name meant, is a different claim and needs its own record.

## Touches

- `src/workflows/snapshot.ts`
- `src/executions/runner.ts`
- `src/executions/record.ts`
- workflows
- executions

## Supersedes

none
