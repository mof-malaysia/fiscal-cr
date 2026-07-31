# FiscalCR Agent Guide

Router for this repo. Full walkthrough: [`index.md`](index.md). Subsystem deep-dives: [`subsystems/`](subsystems/).

## Pick a guide by task

| Task | Read |
| --- | --- |
| First time in the repo / broad orientation | [`index.md`](index.md) |
| Review pipeline, grouping, scoring, dedupe, fast path | [`subsystems/review-pipeline.md`](subsystems/review-pipeline.md) |
| Webhooks, checks, reviews, sticky state, fingerprints, threads | [`subsystems/github-integration.md`](subsystems/github-integration.md) |
| Config precedence, providers, retries | [`subsystems/config-and-providers.md`](subsystems/config-and-providers.md) |
| Finding which file to change | [`index.md`](index.md#task-to-path-routing) |
| Adding or changing tests | [`index.md`](index.md#testing-map) |
| Command / build / release mechanics | [`index.md`](index.md#commands) |

## Source-of-truth hierarchy

1. Running code under `src/` (plus `action/index.ts`) — what ships is the spec.
2. `src/config/schema.ts` (zod) — canonical config definition; `src/config/defaults.ts` mirrors it.
3. [`README.md`](../README.md) — user-facing behavior, configuration reference.
4. `test/unit/*.test.ts` — executable spec of current behavior.
5. `.agents/**` — navigation layer only; if it contradicts code, trust the code and fix this doc.

## Non-negotiables

- **Both entry points** — self-hosted App (`src/index.ts` → `src/app.ts` → `src/github/webhooks.ts`) and GitHub Action (`action/index.ts`) — share `ReviewOrchestrator` and must keep working after any change.
- **`action/dist/` is generated** by `pnpm build:action` (ncc bundle) and committed. Rebuild and commit the result; never hand-edit. `tsconfig` excludes it.
- **Config changes touch schema + defaults together.** Invalid repo config fails fast by design (`loadConfig` throws `ConfigError`); missing config falls back to defaults.
- **Behavioral changes need focused tests** (`pnpm test`, vitest) and a green `pnpm lint` (`tsc --noEmit`).
- **Review state is a hidden marker** inside the sticky PR comment (`<!-- fiscalcr:state:v1 … -->`) — no external storage. Changing the `ReviewState` shape requires bumping the marker version and handling old markers.
- **Don't break review invariants**: check run reflects *cumulative* PR health (open counts), fingerprints are stable identities (dedupe), state is saved last, and every GitHub cleanup failure degrades to a log line.

## Task → path quick map

| Task | Paths |
| --- | --- |
| Review orchestration / lifecycle | `src/review/orchestrator.ts` |
| Review scope (delta vs full vs skip) | `src/review/delta.ts` |
| Pipeline pass 1 (intent) | `src/pipeline/pass1-intent.ts` |
| Pipeline pass 2 (group review) | `src/pipeline/pass2-review.ts` |
| Pipeline pass 3 (synthesis) | `src/pipeline/pass3-synthesis.ts` |
| Grouping, fast path, prompts, parsing | `src/pipeline/{grouper,fast-path,prompts,schemas}.ts` |
| GitHub API, comments, state, threads | `src/github/*.ts` |
| Config, providers, tokens | `src/config/*`, `src/providers/*`, `src/utils/tokens.ts` |
