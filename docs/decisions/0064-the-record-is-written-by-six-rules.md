# 0064. The record is written by six rules, and one name per thing

Status: accepted
Date: 2026-10-06
Run: manual

## Context

The convention in `plugins/gate/reference/docs.md` said what each document holds and in what sections. It said nothing about how to write a sentence. The record has three readers. A person reads it months later, often in a second language. The reviewer decides which sentence a change made untrue. Search reads it too: FTS5 with the `porter unicode61` tokenizer matches word forms but not synonyms. Cross-team matching compares a design doc's file name and its `## Interfaces` lines as written. This repository already names some things two ways, for example "run" and "execution". The person asked whether ASD-STE100 (Simplified Technical English) would help.

## Decision

The record is written by six rules taken from ASD-STE100: one fact per sentence, active voice with the actor named, one name per thing, no idioms, code names in backticks, and numbers stated. A repository may keep `docs/GLOSSARY.md` with one name for each thing. The rules are guidance. Nothing checks them, and the reviewer raises only two names for one thing as a finding.

## Rationale

Short sentences with one fact each make "rewrite the sentence that is no longer true" a precise act. One name per thing is the rule that search depends on, because a synonym splits every search for it. The other rules cost a writer little and help a reader in a second language. Models read complex English well, so the rules are for people and search, not for the agents.

## Alternatives

Adopt ASD-STE100 in full. Its dictionary of about 900 approved words was built for maintenance procedures. Rationale and Alternatives argue a case, and that dictionary cannot carry the argument. Only commercial tools check conformance, so the reviewer would check it by judgement and add noise to every run. The standard is also English-only.

Check the rules in code, in `npm run docs:check`. Sentence length can be counted, but a long sentence is sometimes right, and the useful rules (one fact, one name) are judgements. A check that fails correct text teaches people to work around it.

Rewrite the existing record to the new rules and names at once. That is churn across every design doc for no change in behaviour. A document moves to the rules when its feature is next changed.

Make every style rule a review finding. Each run would carry findings about wording, and the reviewer's real findings would be harder to see.

## How it works

`docs.md` has a "How to write it" section with the six rules and the glossary's form: alphabetical, `**term** — definition. *Not:* other, names.` `/gate:init` writes by the rules and writes a glossary only where it found one thing under two names. Where the code and the UI disagree, it asks which name to use. The shipped implementer, quick implementer and `record-fix` carry the rules in their prompts. The reviewer and the quick reviewer never raise style. Both raise a document that gives one thing two names, or uses a name the glossary lists under *Not*. The reviewer raises it as a record finding, so it takes the `record-fix` edge. `dev-quick` has no `record-fix`, so the quick reviewer sends it back to the quick implementer. This repository's own `docs/GLOSSARY.md` lists its names, and the open choices wait for the person.

## Consequences

A run's record is written in plainer English, and a search finds a thing under its one name in every document written after this. Documents written before this keep their old names until their feature changes, so search misses them until then. A glossary can fall behind the code; a renamed thing needs its entry changed in the same change. The shipped agent prompts changed, so a gate needs `npm run defaults:restore -- --refresh` to get them.

## Touches

- `plugins/gate/reference/docs.md`
- `plugins/gate/commands/init.md`
- `src/agents/defaults.ts`
- `docs/GLOSSARY.md`
- `docs/design/the-record.md`
- the-record

## Supersedes

none
