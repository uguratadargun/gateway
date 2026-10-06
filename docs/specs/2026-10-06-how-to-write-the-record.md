Status: done
Branch: feat/how-to-write
Decisions: docs/decisions/0064-the-record-is-written-by-six-rules.md
Design: docs/design/the-record.md

# How to write the record

## What was asked

The person asked whether ASD-STE100 would help the documents `/gate:init`
and the workflows write. The answer was to take six of its rules and leave
its dictionary out. The person then asked for the three parts proposed: the
rules in the docs reference, the rules in the shipped agents' prompts with
one review finding, and a glossary for this repository. Three sessions
shared the work. When the glossary listed nine names that the code and the
dashboard disagree on, the person accepted the proposed name for each.

## What counted as done

- `plugins/gate/reference/docs.md` has a "How to write it" section: the six
  rules, the glossary's form, and the one finding a reviewer raises.
- `/gate:init` writes by the rules and writes `docs/GLOSSARY.md` only where it
  found one thing under two names, asking where the code and the UI disagree.
- The shipped implementer, quick implementer and `record-fix` carry the six
  rules in one shared paragraph. The reviewer and the quick reviewer never
  raise style. A document that gives one thing two names, or a name the
  glossary lists under *Not*, is a record finding in `dev` and `dev-auto`,
  and goes back to the quick implementer in `dev-quick`. Tests hold both.
- `docs/GLOSSARY.md` lists this repository's names, one entry per thing,
  with nothing left open. No existing document is renamed.
- Version 0.52.0; `npm run typecheck`, `npm test` and `npm run docs:check`
  pass.
