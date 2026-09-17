Status: done
Branch: remove-difficulty-routing
Decisions: docs/decisions/0015-the-gateway-resolves-names-never-difficulty.md
Design: docs/design/routing.md (rewritten), docs/ARCHITECTURE.md, docs/design/gateway-pipeline.md, account-pool.md, providers.md, agents-and-skills.md, dashboard.md, dev-workflow.md, workflows-engine.md

# Removing difficulty-based model routing

## Goal

gate classified every request into a difficulty category from its shape and
picked a Claude tier for it. Remove that, and everything that existed only to
contain it, so gate serves the model the caller names.

The case, in short: the mechanism's inputs are measured to be poor (a
production router on length and keywords scored 38.4% against a 20% random
baseline, and below the "always use one strategy" baseline); a rule-based
router is measured to cost more than not routing at all ($172.56 / 73-of-100
against $54.73 / 74-of-100 unrouted); and model switching rebuilds the prompt
cache, which is the larger lever. The information was already declared
upstream — every shipped agent names its model, and Claude Code names its own.

Four scoping decisions were taken with the user before any code moved:
`auto` is refused rather than defaulted; `applyClaudeCode` writes no model into
the user's settings; sticky sessions go; the throttle's tier downgrade goes.

## Done

**Deleted.** `src/lib/grader.ts` and its `grades` table, the difficulty block
in `src/lib/router.ts` (categories, keywords, thresholds, presets,
`gradeToRoute`, `TIER_RANK`, `cheaperTier`, `overrideExplicit`), the grader,
sticky and throttle-downgrade blocks in `dispatch`, the `stickyKey` half of
`sessionFromRequest`, `getSessionRoute`/`setSessionRoute`,
`src/components/routing-simulator.tsx` and the `POST /api/routing` dry-run it
called, two of the three routing cards, and the `routingPrecision.countTokens`
and `throttle.downgradeAt` settings. `x-gate-throttled` is gone with the
mechanism that set it.

**Kept, deliberately.** The tier fallback chain and the Haiku oversized-prompt
retry — rescues from a hard failure, not optimisations. `reasoning.ts` is
untouched: effort remains the one lever gate turns, and a client that sets its
own is never overridden. `estimateTokens` survives to report
`x-gate-tokens-est` and nothing reads it for a decision.

**Changed.** `routeModel` resolves provider ref → concrete `claude-*` → alias
and throws `UnresolvedModelError` on anything else, which `dispatch` returns as
a 400 naming the three forms that work. `routing.json` narrows to `tiers`,
`aliases`, `default`; a pre-0.39 file keeps its old keys on disk and the loader
ignores them, so no migration is needed. `applyClaudeCode` writes only
`ANTHROPIC_BASE_URL` and strips a stale `ANTHROPIC_MODEL=auto`, the `auto`
picker row and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — so `/gate:login` repairs a
machine connected before this release. `auto` is gone from the five connect
snippets, `/v1/models` and the playground.

**Record.** Decision 0015 written; `docs/design/routing.md` rewritten in the
present tense; sentence-level corrections across ARCHITECTURE, the pipeline,
account pool, providers, agents-and-skills, dashboard, dev-workflow and
workflows-engine; README's pitch and its `auto` instruction; `authoring.md`'s
"Models — who answers". Changelog's unreleased bullet announcing "Route named
models too" removed — it added, unreleased, the feature this removes — and four
lines added. Version triple bumped to 0.39.0, forced by the `plugins/` edit.

Decision 0013's example cites the three routing cards and is now stale. Its
decision is unchanged, so per the forms it is neither edited nor superseded.

**Verified.** `npm run typecheck` clean, `npm test` 688 passing,
`npm run build:cli` clean. `tests/routing-eval.test.ts` deleted;
`tests/router.test.ts` rewritten around resolution and refusal, including that
the same name resolves identically whatever the prompt looks like.
