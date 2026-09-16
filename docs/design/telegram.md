# Telegram

## Summary

A person's remote sessions can be answered from Telegram, and runs started
from there. The bot is a cockpit in a chat: it follows the person's sessions
on the server on their own key, sends every question, plan approval and
permission prompt as a message with buttons, and settles it through the
same calls a cockpit's panels make. Whichever side answers first wins; the
other sees the prompt go.

## How it works

### Setup

Make a bot with @BotFather and put its token on the Team page, where it is
sealed under `GATE_SECRET`, or set `GATE_TELEGRAM_BOT_TOKEN`; the environment
wins over the dashboard. The token is checked with Telegram before it is
saved, and the bot is started, restarted when the token changes, and
stopped when there is none. The bot polls Telegram (`getUpdates`) rather
than taking a webhook: a gate is usually on a machine nothing on the
internet can reach, and long polling needs nothing from the network but a
way out. One bot per process; route handlers and the startup hook are
separate module graphs, so it hangs off the process the way the remote
manager does — two pollers on one token would take each other's updates.

### Linking a chat

On the Team page, *Create link* for a person makes a one-time
`t.me/<bot>?start=<code>` link, valid 15 minutes. Opening it — or sending
`/start <code>` to the bot — links that chat and mints a key for the person
with the `gateway`, `workflows` and `remote` scopes, kept sealed because a
session runs on the plaintext; it shows among their keys. The link is what
lets a chat start sessions on the server, so it is issued as deliberately
as a remote key is, for a named person. A chat that was linked before is
relinked and its old key revoked. The key is resolved on every use, so
revoking it, disabling the person, or unlinking the chat stops the bot at
once. Unlinking — from the Team page or `/unlink` in the chat — revokes the
key. Only private chats are answered: in a group, anyone present could press
the buttons.

### Following a person's sessions

For every linked chat the bot subscribes to that person's sessions the way a
cockpit does, on the chat's own key, and brings the chat's messages in line
with what is waiting: new prompts are sent, prompts that have gone are
marked as no longer waiting. Everything that happens for one chat — a frame
from the hook hub, a button, a message — is done in order on that chat's own
chain, so a button pressed while its question is still being sent meets the
question, not a race. The chat is also told when the person's runs start and
end.

### Answering

A question reads the way the cockpit's form does: the context the session
gave, each question with its options, and the picks so far. Tap an option; a
single question with a single answer is sent at once, several questions are
walked one by one and sent with Submit. *Other…* takes a typed answer.
Replying to a question's message sends a note instead; replying to a
permission prompt denies it with that reason. A message is capped below
Telegram's 4096 characters, and button payloads carry ids only, since
Telegram allows them 64 bytes; the names stay in the bot's memory. Text that
came from a session is escaped before it is sent, since every message is
HTML-formatted.

### Running from the chat

`/run` asks for a repository, a workflow (or lets the run pick), and the
task, then starts a remote session typed `/gate:run <workflow> <task>` as its
first prompt; `/run <repo> <workflow> <task…>` does it in one line, and a
task given without a workflow is left to the run to route, as `/gate:run
<task>` is. The run is an ordinary remote session: a `claude` on the server
in one of its repositories, on the person's key, in their run list.

| command | what it does |
| --- | --- |
| `/run` | start a run: pick a repository and a workflow, then say what it should do |
| `/sessions` | the person's live sessions, with a button to close each |
| `/pending` | send again everything that is waiting on them |
| `/cancel` | forget a run or an answer being typed |
| `/unlink` | disconnect this chat from gate |
| `/help` | what the bot does |

### Not covered

Questions from sessions running in a desktop cockpit on the person's own
machine are held by that cockpit, not by the server, so they do not reach
Telegram. The bot holds nothing a person has to settle — the hook hub in the
remote sessions layer does (see `remote-sessions.md`); the bot is one more
place to answer from.

## Key files

- `src/telegram/bot.ts` — the bot: linked chats, following their sessions, prompts as messages, `/run` and the other commands, run notifications
- `src/telegram/render.ts` — what the bot says and what its buttons mean, with no I/O
- `src/telegram/api.ts` — the few Bot API calls, over plain fetch, long-polling
- `src/telegram/store.ts` — the token, the one-time link codes, the links and the keys they hold
- `src/telegram/runtime.ts` — the one bot per process, started and restarted with the token
- `src/app/api/telegram/` — the bot's state and links for the Team page; setting the token; creating and removing links
- `src/instrumentation-node.ts` — starts the bot at boot when a token is configured

## Pitfalls

- A gate without a token never loads the Telegram code; setting the token on the Team page starts the bot without a restart, but `GATE_TELEGRAM_BOT_TOKEN` in the environment overrides whatever the page holds.
- A group chat is ignored entirely; the bot answers private chats only.
- A link code is one-shot and expires in 15 minutes whether or not it worked; relinking a chat revokes the key it had.
- The bot cannot answer a prompt held by a desktop cockpit; only server-side sessions reach it.
- A 429 from Telegram is honoured with the wait it names; a burst of prompts on one chat is delivered in order, not at once.

## Decisions

- none recorded yet
