# 0030. An optional field may be written as null

Status: accepted
Date: 2026-09-21
Run: manual

## Context

An agent's `output.schema` declares its answer field by field, and a type
ending in `?` means the field is optional — `gaps: string?`, `conflicts:
object[]?`. Every `?` a shipped agent declares is the same kind of field:
say something only if there is something wrong. The verifier's `gaps`, the
planner's `conflicts`, the reviewer's `blocking` are all "nothing to
report" fields.

`buildOutputSchema` built those as `base.optional()`, which in zod accepts
the key being absent and nothing else. A model handed a list of keys and
told to answer in exactly that shape writes all of them, and spells the
empty one `null`. That answer was refused.

Refusing it is not free. It lands at the end of a node, after the work: a
verifier that has read the branch, run the tests and found nothing wrong
writes `{"verified": true, "gaps": null}`, and `gate step` rejects the
file. In the run this was found in, the session read the error, rewrote
the file by hand and handed it back — the work survived because a person's
session was driving. A detached worker has no such recourse.

Nothing caught it because no test anywhere had put a `null` against a `?`
field.

## Decision

A `?` field reads `null`, `undefined` and absent as the same answer:
nothing to say. The value is normalised to absent, so nothing downstream
has to know which spelling arrived. A field without a `?` is untouched —
it must be present, and `null` is not an answer for one.

The six places the notation is explained to a model or to an author now say
so in the same words: the two executors' trailing prompt sentence, the
`answerFileNotice` the session writes into a delegate's prompt,
`plugins/gate/commands/run.md`, `plugins/gate/reference/authoring.md` and
`docs/design/agents-and-skills.md`.

## Rationale

The distinction the old schema drew — absent means nothing, `null` means
something else — is one no shipped agent makes and no consumer of an output
reads. `outputs.verifier.gaps` is tested for truthiness by the conditions
that route on it, and `null` and absent are both falsy. There was no
meaning being protected, only a spelling being enforced.

The cost of enforcing it is paid at the worst moment. Schema validation is
the last gate before a node's output is recorded, so the answer refused is
always a finished one. A strictness that throws away completed work to
insist on one of two identical spellings is not strictness.

Saying it in one wording everywhere matters as much as the code: an agent
author writing `notes: string?` and a model reading "a type ending in ? is
optional" were being told two different things about what to write when
there is nothing to write.

## Alternatives

**Leave the schema and tell the models harder.** The instruction was
already there, in four places, and the models still wrote `null` — it is
what JSON says about an empty field. An instruction that is disobeyed at
the rate this one is is a specification of the wrong thing.

**Coerce in the executor, before validation.** Stripping nulls from the
parsed object before handing it to the schema would have the same effect
for JSON outputs, but it moves the rule away from the declaration it
belongs to, and it would strip a null that a required field really did
carry, turning a refusal into a silent absence.

**Make `?` mean nullable and keep absence separate.** The mirror of the old
behaviour, and no better: a model that leaves the key out is answering, and
refusing that is as arbitrary as refusing `null`.

## How it works

`buildOutputSchema` in `src/agents/types.ts` wraps an optional field in
`optionalField`, which is `base.nullish().transform((v) => v ?? undefined)`.
`nullish` accepts the key absent, `undefined`, or `null`; the transform
turns all three into `undefined`, which `z.object` drops from the parsed
result. A required field is built from `fieldValidator` alone and rejects
`null` as it always did. The object keeps `.passthrough()`, so extra keys a
model adds are kept rather than rejected.

The three-line difference is held by two tests in `tests/agents.test.ts`:
one that parses `{verified: true, gaps: null, conflicts: null}` down to
`{verified: true}` and reads a real value through unchanged, and one that
still refuses `null` on a required field and a wrong type on an optional
one.

## Consequences

An output that was refused is now accepted, and the node advances. No
output that was accepted changes: a `?` field that arrived with a value is
unchanged, and a `?` field that was absent was already absent.

A condition reading a `?` field sees `undefined` where it might have seen
`null`. Both are falsy and the expression language has no `=== null`, so no
shipped edge changes its verdict.

An agent that wanted to distinguish "I looked and there is nothing" from "I
did not look" cannot do it with `null` on a `?` field. None does, and the
way to do it is two fields.

## Touches

- `src/agents/types.ts`
- `src/runtime/executors/agent.ts`
- `src/runtime/executors/claude-code.ts`
- `src/client/step.ts`
- `plugins/gate/commands/run.md`
- `plugins/gate/reference/authoring.md`
- `docs/design/agents-and-skills.md`
- `tests/agents.test.ts`

## Supersedes

none.
