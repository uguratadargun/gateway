# 0045. Gate's own agent loop clears old tool results instead of re-sending them

Status: accepted
Date: 2026-09-23
Run: manual

## Context

An agent on gate's own executor (`recall`, `decide`, `plan-review`, `conflict-review`, `acceptance`, the `ask` reviewer) runs in a loop that re-sends the whole conversation every round, and every tool result stays in it. Nothing is ever removed. On the live gate, one `ask` reviewer answering one question took 119 rounds and re-read 8.4M cached tokens, besides 500 thousand uncached ones. Prompt caching made that affordable, not small. A longer node keeps growing until it reaches the model's context window and fails. Claude Code compacts its own conversation, and that is why the big nodes run on the `claude-code` executor. The gate executor had nothing of the kind.

## Decision

When one round's context (uncached input plus cache reads) reaches 100 000 tokens, every tool result older than the last five rounds is replaced by a note. The note names the tool and its input, says how many characters it returned, and says to call it again if they are still needed. Results under 1 000 characters are kept, because the note would cost as much. A result already cleared is not rewritten. The step's own record of each tool call keeps the full result.

## Rationale

Old tool results are what grows. The prompt, the system text and the model's own turns are small next to the files it read, and an agent that read a file twenty rounds ago has either used it or will read the part it needs again.

The clearing is done in one batch, once the context passes the threshold, and not one result per round. Rewriting an earlier message costs a prompt-cache miss from that message on. Clearing a little every round would pay that miss every round. Clearing everything old at once pays it once, and the context then grows back from a small base until the next time.

The note keeps the call, not the content. That is enough for the agent to know what it already looked at, and to fetch it again, which costs one round, instead of carrying it for the rest of the node.

## Alternatives

Summarise the old conversation with a model, as Claude Code does. That costs a model call, the summary can drop the one detail that mattered, and it moves judgement into the loop. The tools can already reproduce any result exactly, so the note is enough.

Cap tool rounds. A cap kills the node after it has been paid for, and there are no run ceilings in this repository.

Move every agent to the `claude-code` executor. The small gate agents are there because they need no subprocess, no Claude Code install and no session. They would carry the cost of one to fix a problem the loop can fix itself.

Clear each result after a fixed number of rounds, regardless of size. A small conversation would lose results for nothing and pay cache misses it did not need to.

## How it works

`executeAgentNode` keeps a map from tool-use id to its call record. After each round's tool results are appended, if that round's `inputTokens + cacheReadTokens` is at or over the threshold, `clearOldToolResults` finds the user messages that carry tool results. It leaves the last five alone. In every earlier one it replaces each tool result over 1 000 characters with the note, and it builds new message objects rather than changing the ones already sent. Results that already start with the note's mark are skipped.

## Consequences

A long gate-executor node stays under the context window, and each round re-sends less. The rounds right after a clearing miss the prompt cache once.

An agent can re-run a call it needs again, which costs one round. If an agent needs many old results at once, it can clear and re-read in a loop. That shows up as repeated identical tool calls on the step.

The threshold is a constant and not a per-agent setting. A model with a much smaller window than 100 000 tokens would need it lowered.

## Touches

- `src/runtime/executors/agent.ts`
- `tests/agent-tools.test.ts`
- `docs/design/workspaces.md`

## Supersedes

none
