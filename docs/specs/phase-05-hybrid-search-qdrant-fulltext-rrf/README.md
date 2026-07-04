# Phase 05 — Hybrid Search (Qdrant Full-Text + RRF)

**Status:** in-progress
**Started:** 2026-07-04
**Done:** n/a

## Isolation
- **Branch:** `main`
- **Worktree:** n/a

## Pointers
- **Tasks:** `p5-T01` … in [`./TASKS.md`](./TASKS.md) (this folder)
- **Spec:** [`./requirements.md`](./requirements.md), [`./design.md`](./design.md)
- **Related specs:** Phase 03 (`../phase-03-document-deletion-and-agentic-rag/`) — original `migratePayloads()` shape reused; Phase 04 (`../phase-04-user-accounts-and-private-knowledge/`) — `app_metadata` collection + `mergeWithVisibility()` reused.

## Why isolated
DocKhoj's retrieval today is dense-only: one cosine query against the `documents` collection's single 768-dim vector. That works for paraphrased natural-language questions and fails on **exact lexical recall** — error codes, function names, package names, version strings, acronyms, log fragments, unique IDs. The corpus is user-uploaded PDFs / DOCX / MD / TXT, dominated by exactly this kind of content.

Phase 05 adds a parallel **lexical** retrieval channel (Qdrant full-text payload index) and fuses both via Qdrant-native **RRF** over `prefetch: […]`. One `client.query()` call replaces the current single `query:`.

## Why main (no branch / worktree)
The change is **localized to the retrieval path**:
- `src/services/qdrant.ts` — one new payload index, one migration flag, one enriched upsert field, one rewritten `client.query` call. ~60 lines of diff.
- No schema. No SPA. No auth. No new dep. No env var.
- `routes/search.ts`, `routes/chat.ts`, `services/stream-chat.ts`, `services/agent-loop.ts` each pass the raw query string to `searchChunks` (already in scope) — at most one line per call site.

This is the textbook case for "land on main": small, contained, no destabilization, fully rolled back by `git revert`. A dedicated branch would buy nothing except merge overhead.

## Scope summary
- **Storage.** Add a Qdrant `text` payload index on a new `searchText` field. Backfill `searchText = chunk.payload.chunk` on every existing point via a one-shot migration, mirroring `migratePayloads()` (Phase 04) with its own `app_metadata` flag (`phase_05_search_text_migration_applied`).
- **Retrieval.** Rewrite `searchChunks` to use `client.query` with two prefetches: (a) dense cosine on `queryVector`, (b) full-text on `searchText`, top-level fused via `rrf`. Top-level `filter` (visibility + page/filename scope) applies to the fused result.
- **API surface.** No change. The public endpoints (`/api/search`, `/api/search/rag`, `/api/chat`, `/api/chat/stream`) accept the same query string; internally that string flows into the lexical prefetch.
- **Tests.** One vitest that mocks `client.query` and asserts the prefetch/rrf shape. E2E via `./restart.sh` + curl: ingest a doc with a unique literal token, confirm it ranks top via lexical recall.

## Out of scope (this phase)
- **Learned sparse (SPLADE).** Plain BM25-equivalent (Qdrant full-text payload index) is the lift-on-exact-recall story; a learned sparse model would change the upsert path and add a dependency — separate phase if measured results demand it.
- **Rerankers (Cohere / Jina / cross-encoder).** RRF is the established baseline; rerankers belong on top of an already-hybrid retrieval, not phase one.
- **Per-tenant lexical indexes.** One global `text` index on `searchText` is enough; per-tenant adds Qdrant collection count for zero current benefit.
- **Schema changes (`conversations.db`).** None. Qdrant schema only.
- **SPA, auth, env vars.** None.
- **Configurable over-fetch factor.** Hard-code `max(limit * 2, 10)` per prefetch; revisit when measured.
- **Removing the dense-only fallback.** Every current call site threads the query string after Phase 05 lands; the fallback stays so future internal callers don't trip on a missing-arg regression, but it's not a documented behavior.

## Decisions deferred to review
See `requirements.md` → "Open questions" and `design.md` → "Open decisions".
