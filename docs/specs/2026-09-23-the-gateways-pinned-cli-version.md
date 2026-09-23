Status: done
Branch: gate/cli-version-pin
Decisions: none — the pin is the existing design, only its value was wrong
Design: none — no design doc describes the wire image's version

# Why a new model answered 400 through the gateway

## Goal

A session on this machine, on Claude Code 2.1.280 and pointed at a team gate by
`ANTHROPIC_BASE_URL`, asked for a model newer than the gateway's pin and got:

```
API Error: 400 Claude Code 2.1.259 does not support this model;
version 2.1.280 or newer is required. Run 'claude update', or update
the Claude desktop app, then try again.
```

The number in the message belongs to nothing the person installed. The question
to answer was where it came from, and whether gate was carrying a stale SDK.

## What was true

gate has no Anthropic SDK — `package.json` lists none, and a node is a real
`claude` process. So nothing was out of date in that sense. What is out of date
is a constant: `src/lib/claude/config.ts` pinned `CLAUDE_CODE_VERSION` to
`2.1.259`, and `src/lib/claude/identity.ts` builds the whole upstream header set
from scratch — `User-Agent: claude-cli/<pin> (external, cli)` among them. The
client's own headers never reach Anthropic. Every request through
`/api/gateway`, from any CLI of any version, is a 2.1.259 request.

Anthropic gates its newest models on that number, so the wall was gate's, and
the message's advice — update your CLI — could not lift it.

Two things were checked before moving the pin:

- `X-Stainless-Package-Version` is still `0.112.1` in the 2.1.280 binary (`var
  ne="0.112.1"`), so the rest of the wire image does not move with it.
- The account's live model list, which the gateway serves from Anthropic's own
  `/v1/models`, tops out at `claude-fable-5-1` — there is no Fable 5.5. The id
  that actually hits the version wall is `claude-opus-5-5`; `claude-fable-5-1`
  answers today.

## What counted as done

The pin reads `2.1.280`, the comment beside it says what the number is for and
what Anthropic does when it lags, and the changelog has the line. A live gate
that is not being rebuilt takes `CLAUDE_CODE_VERSION=2.1.280` from its
environment — the constant already honours it.

## Pitfall this leaves

The pin is a number a person must remember to move. Nothing fails loudly when it
lags; a model released after it simply refuses, quoting a version the person
does not have installed and cannot find on their machine.
