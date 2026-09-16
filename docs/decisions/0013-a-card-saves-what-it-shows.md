# 0013. A card saves what it shows

Status: accepted
Date: 2026-09-16

## Context

The dashboard home page is where a gate is configured, and it had grown three
different answers to "did my change stick?". The accounts panel wrote to the
server on every keystroke. The providers panel tracked a draft per row and
showed a Save only where something differed. The routing and settings panels
were the odd ones: not cards at all but sections, each with a single Save
pinned to a header row above everything it saved, no check for whether anything
had changed, and a "Saved" label that flashed for a second and a half whether
or not the write worked.

The section form failed in the ordinary case. Pointing a tier at a provider
model is done in the last card of the routing section; the button that saves it
is three cards up, off screen. A person edits the control, looks for the
button, and does not find it where they are looking.

It also lost writes. Both section Saves PUT the whole document they had loaded.
The settings panel's document includes `accountPool`, which the accounts panel
writes independently — so changing the rotation and then saving an unrelated
settings group put the rotation back.

## Decision

Every panel on the page is a `Card`. A card that holds editable state owns a
named set of keys, keeps the slice it last loaded, computes `dirty` against it,
and ends in a `SaveRow` — one button, in the card's own footer, disabled until
something actually changed. Saving PUTs that card's keys and nothing else, and
adopts the server's answer as the new baseline. A failed write is shown next to
the button instead of being flashed over.

## Rationale

The button belongs under the control because that is where the person is
looking when they finish editing. Any arrangement that puts it elsewhere is
asking them to remember where it lives.

The narrow write is also the safe one. `PUT /api/routing` and `saveSettings`
already merge a patch key by key, so sending only a card's own keys was always
supported — the panels were choosing to send more than they knew about, and
that is exactly how one panel overwrote another's field with a stale copy.

A `dirty` check is what makes the button mean something. A Save that is always
enabled and always says "Saved" afterwards reports that a write was attempted,
which is not the question being asked.

The rest of the repository had already settled this: the workflow, agent and
skill editors each compute `dirty` and render `Save`/`Saved` against it. The
dashboard was the last surface doing something else.

## Alternatives

A sticky bar at the bottom of the page that appears when anything is unsaved.
One button for the whole page, always reachable — but it saves everything at
once, which keeps the wide write and the clobber with it, and it hides which
card the pending change is in.

Autosave on change, as the accounts panel did. It removes the button and the
question, but a mistyped threshold reaches live routing before the digit after
it is typed, and there is nothing to not-press.

Keep one Save per section and move it to the bottom. Closer, but a section is
three cards tall; the button is still not under most of what it writes.

Split the page into routes or tabs so each section is short enough for a header
button. It changes how the whole surface is navigated to fix where one button
sits, and the rail is deliberately flat.

## How it works

Each panel declares an `OWNS` map from card name to the config keys that card
renders. `sliceOf(state, keys)` builds the payload; `dirty` is that slice
compared against the same slice of the baseline, so editing one card never
enables another's button. `SaveRow` renders the footer: the button, disabled
while clean or in flight, and one line that says "Unsaved changes", or the
error the write returned.

The routing panel splits three ways — the difficulty table, how difficulty is
decided, and the model behind each tier. The settings panel splits six ways,
one per question it answers. The accounts panel's rotation block keeps its own
baseline and saves `accountPool` alone.

Section headings moved out of the panels and onto the page, so a panel is only
ever a card and every heading on the page has one shape.

## Consequences

A person changing two cards presses Save twice. That is the trade: the write is
scoped to what they were looking at.

A card whose keys are not in its `OWNS` list will appear to save and silently
not persist. Adding a control to a card means adding its key there too.

Panels no longer write fields they do not render, so a panel can be opened and
saved without carrying another's state — `accountPool` is the case that was
actually broken.

Anything that adds a page-wide Save, or writes a whole document from one card,
reverses this record and needs its own.

## Touches

- `src/components/save-row.tsx`
- `src/components/routing-rules-panel.tsx`
- `src/components/settings-panel.tsx`
- `src/components/accounts-panel.tsx`
- `src/app/page.tsx`
- dashboard

## Supersedes

none
