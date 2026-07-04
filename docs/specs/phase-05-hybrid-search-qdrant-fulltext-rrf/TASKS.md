# Phase 05 — Tasks

Task IDs use `p5-TNN`. Each task is one commit, testable in isolation. Status starts at `todo`; flip to `in-progress` when started, `done` when acceptance criteria are met.

Each task ends with: `./restart.sh` (clean rebuild + smoke) AND `npm test -- --run` passing, per project `CLAUDE.md` §3. No commit without both passing.

> **Isolation.** All three tasks land on `main` directly (no branch, no worktree — see `README.md` → "Why main"). The phase is small, contained, and reversible per-task.

## T1. `searchText` payload + `text` index + one-shot backfill

- **Description.** Three coordinated changes in `src/services/qdrant.ts`:
  - Add `searchText?: string` to `DocumentChunkPayload`.
  - In `ensurePayloadIndexes()`, add one `field_schema: 'text'` index entry for `searchText`, idempotent on re-boot.
  - In `upsertChunk` and `upsertChunks`, set `payload.searchText = payload.chunk` on every point.
  - Add a new function `migrateSearchTextPayloads()` that mirrors `migratePayloads()` line-for-line — `scroll(limit: 100)`, set `searchText = chunk` on points missing the field, write flag `phase_05_search_text_migration_applied` to the existing `app_metadata` collection. Idempotent on re-boot.
  - In `src/index.ts`, call `migrateSearchTextPayloads()` after `migratePayloads()` on boot.
  - In `src/utils/qdrant-migration-flag.ts` (new tiny file, 1 export) — actually **no new file**: the existing `MIGRATION_FLAG_KEY` literal + `metadataPointIdFor()` switch in `qdrant.ts` handles it (extend the switch with the new key; or inline a tiny UUID literal as Phase 04 did for the Phase 04 flag). Add the new key as a sibling constant + UUID literal. Same shape as `MIGRATION_FLAG_KEY`.
- **Maps to requirements.** FR-1, FR-2, FR-3, NFR-5, NFR-6.
- **Maps to design.** §"Data model"; §"Implementation order" step 1.
- **Acceptance criteria.**
  - `npm test -- --run` is green; new test in `tests/services/qdrant.test.ts` asserts `upsertChunks` writes `searchText === chunk` on every point.
  - New test in `tests/services/qdrant-migration.test.ts` (sibling) asserts `migrateSearchTextPayloads()` writes the flag once on the happy path, and is a no-op when the flag is pre-set.
  - `./restart.sh` cold-boot reports "Qdrant searchText migration complete" with a non-zero `updated` count on a fresh volume. A second `./restart.sh` reports "already applied".
  - `curl http://localhost:6333/collections/documents` (Qdrant REST) shows `searchText` indexed with `text` type after first boot.
  - No `searchChunks` call site touched in this task (signature unchanged). Visibility tests untouched.
- **Dependencies.** none.
- **Estimate.** S.
- **Status.** done.

## T2. Hybrid `searchChunks` + thread `query` through callers

- **Description.** Rewrite `searchChunks` in `src/services/qdrant.ts`:
  - Extend `SearchOptions` with optional `query?: string`.
  - Replace the single `client.query` `query:` argument with `prefetch: [dense, lexical?]`, top-level `query: { fusion: 'rrf' }`. Compute `prefetchLimit = Math.max(opts.limit ?? 5, 10) * 2`. Include the lexical prefetch only when `typeof opts.query === 'string' && opts.query.length > 0`.
  - Top-level `filter` is `mergeWithVisibility(buildSearchFilter(opts), viewerId)`, unchanged.
  - Thread `query: <user query string>` at the five call sites:
    - `src/routes/search.ts:54` — `query: q`.
    - `src/routes/search.ts:95` — `query: q`.
    - `src/routes/chat.ts:87` — `query: q`.
    - `src/services/stream-chat.ts:50` — `query: params.question`.
    - `src/services/agent-loop.ts:243` — `query: params.question`.
  - Update test mocks (`tests/test-helpers.ts`, `tests/services/stream-chat.test.ts`, `tests/routes/search.test.ts`, `tests/routes/search-auth.test.ts`) for the new positional expectation where they assert call shape.
- **Maps to requirements.** FR-4, FR-5, FR-6, FR-7, NFR-1, NFR-3, NFR-4.
- **Maps to design.** §"Key algorithm"; §"API surface"; §"Implementation order" step 2.
- **Acceptance criteria.**
  - `npm test -- --run` is green; the new call-shape test in `qdrant.test.ts` pins the hybrid structure (two prefetches, RRF fusion, lexical filter, top-level filter) for a call with `query` set; a separate test pins the dense-only fallback for a call without `query`.
  - `qdrant-visibility.test.ts` is green **without modification** (uses the dense-only fallback).
  - `agent-loop.test.ts` and `stream-chat.test.ts` are green (DI mocks ignore args; the implementation update at the call site is mechanical).
  - `./restart.sh` boots cleanly; `/api/health` returns `{"status":"ok",...}`.
- **Dependencies.** T1.
- **Estimate.** M.
- **Status.** todo.

## T3. E2E walkthrough + protocol commit

- **Description.** Execute the full e2e walkthrough from `design.md` §"Testing strategy → Integration / e2e" against a fresh `./restart.sh` boot, using the curl patterns from `CLAUDE.md` §"End-to-end testing protocol":
  1. Cold-boot `./restart.sh`.
  2. Ingest a probe markdown containing `DOCKHOJ_HYBRID_TOKEN_<random>`. Confirm via `/api/search?q=<token>` that the file returns at rank 1 (FR-8).
  3. Ingest a PDF whose intro discusses a paraphraseable topic. Confirm via `/api/search?q=summary of the introduction` that the intro chunk returns at rank 1 (NFR-3).
  4. Delete the probe file via `/api/documents/:id/delete`. Confirm `/api/search?q=<token>` now returns zero results (FR-6).
  5. Restart `./restart.sh` a second time. Confirm `docker logs dockhoj-app` shows "Qdrant searchText migration already applied" (NFR-6).
- **Maps to requirements.** FR-6, FR-8, NFR-3, NFR-6.
- **Maps to design.** §"Testing strategy"; §"Implementation order" step 3.
- **Acceptance criteria.**
  - All five steps pass with the expected output.
  - `npm test -- --run` is green (no regression).
  - One final commit on `main` references `p5-T03` in the message (e.g. `chore(phase-5): e2e walkthrough + protocol completion (p5-T03)`).
- **Dependencies.** T2.
- **Estimate.** S.
- **Status.** todo.

## Dependency graph

| Task | Depends on | Blocks | Est | Layer |
|------|------------|--------|-----|-------|
| **T1** `searchText` payload + `text` index + backfill migration | — | T2 | S | qdrant |
| **T2** Hybrid `searchChunks` + thread `query` through callers | T1 | T3 | M | service + api |
| **T3** E2E walkthrough + protocol commit | T2 | — | S | e2e |

## Parallel workgroups

Phase 05 is sequential by data dependency — T1's `searchText` field has to exist before T2's lexical prefetch can read it. T3 is terminal.

| Gate | Parallel tasks (no shared files) |
|------|----------------------------------|
| (none — T1 → T2 → T3 is fully serial; no parallelism wins) | |

The phase is too small for phase-swarm fan-out; the workgroups table records this explicitly so a future reader doesn't waste cycles looking for parallelism that isn't there.

## Critical paths

Single chain: **T1 → T2 → T3** (3 tasks, all on `main`).

Wall-clock = sum of the three estimates (S + M + S, ~half a day total). Per-step commit-per-task keeps the diff small and reviewable.

---

## Notes
- Per global CLAUDE.md §3, no commit without `./restart.sh` + `npm test -- --run` passing.
- Per global CLAUDE.md §0, no shortcuts — T1's migration is the full feature (one-shot backfill + flag gating), T2's prefetch is the full feature (two prefetches + RRF + lexical filter), T3 is the full e2e walkthrough. No `TODO` placeholders.
- If a task turns out larger than estimated during implementation, split in this file rather than letting it sprawl.
- Per project CLAUDE.md §"Spec workflow reminder", the active phase's TASKS.md is the only `TASKS.md` that should be edited while this phase is in flight. The root `TASKS.md` index gets a one-line pointer added when T3 lands.