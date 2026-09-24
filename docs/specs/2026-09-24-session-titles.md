Status: done
Branch: fix/session-titles
Decisions: none — a fix inside the existing session design
Design: docs/design/gateway-pipeline.md (the Session paragraph, the title pitfall)

# A session is named by what the user asked

## What was asked

On `/sessions` a session's title was cut halfway and did not show what the
user had written.

## What was found

The title was the first 80 characters of the first user message of the first
request filed under the session id, and Claude Code files three kinds of
request under one id. The live database held, for its latest sessions, the
auto-mode permission classifier's opening ("The following is the user's
CLAUDE.md configuration…"), the conversation's `<system-reminder>` blocks, and
the title request's `<session>` wrapper — the prompt itself, where it appeared
at all, came after the preamble and past the cut. The page then clipped the
title to one line.

## What counted as done

- The title is the prompt: `<session>` unwrapped and its instructions dropped,
  `<system-reminder>`, `<ide_…>` and `<local-command-…>` blocks removed, a
  slash command read as `/name args`, the classifier's requests (CLAUDE.md or
  `<transcript>` first) naming nothing.
  Up to 2000 characters. The session id is computed as before.
- Titles already stored are read once through the same function; those with
  no prompt in them become NULL and the session's next request fills them.
- `/sessions` shows two lines per session and the whole prompt when opened.
- `tests/session-title.test.ts` covers the three request shapes, the length
  and the stored titles; the migration was run against a copy of the live
  database, and every title on the VPS was read through the final version
  before it was deployed: none of 190 still starts with a tag.
