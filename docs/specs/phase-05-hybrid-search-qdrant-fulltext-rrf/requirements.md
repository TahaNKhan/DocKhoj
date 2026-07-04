# Phase 05 — Requirements

## Purpose
DocKhoj's RAG retrieval today is **dense-only**: a single `client.query` against the `documents` collection's 768-dim `nomic-embed-text` cosine vector. That works for paraphrased questions ("how do I configure authentication?" matches "set up login") and **fails on exact lexical recall** — error codes, function names, package names, version strings, acronyms, log fragments, unique IDs, identifiers of any kind. The corpus is user-uploaded PDFs / DOCX / MD / TXT, dominated by exactly this content; self-hosted DocKhoj users are most often technical readers searching for what they remember verbatim.

Phase 05 adds a parallel **lexical** retrieval channel via a Qdrant **full-text payload index**, and fuses both channels with **Reciprocal Rank Fusion (RRF)** inside a single `client.query` call. The user-facing API is unchanged: every endpoint that already accepted a query string now silently benefits from hybrid recall, with no migration step on the client side.

The motivation is correctness, not novelty. Dense-only retrieval is the dominant complaint vector in any technical-corpus RAG product, and the fix is one Qdrant-native feature away. Phase 05 makes DocKhoj's retrieval honest about technical content without changing anything about how the user calls it.

## Users / actors
- **End user (chatting or searching).** Same as today. The query string they type flows into both channels automatically; they get better top-k without changing anything they do.
- **Document owner (uploading).** Same as today. Uploads unchanged; their documents participate in lexical recall on every subsequent search.
- **Administrator.** Same as today. No new env var, no new flag, no new migration step beyond the implicit one-shot backfill on first boot after the upgrade.
- **Agent loop LLM.** Same as today. `searchChunks` is called from `agent-loop.ts:243` and `stream-chat.ts:50` exactly as before — the lexical prefetch rides along for free.

## User stories
1. **Exact-token recall.** Taha uploads a PDF containing the line `ECONNRESET when proxying via ::1`. A week later he searches "ECONNRESET" in `/api/search`. With dense-only the token is buried (nomic-embed-text doesn't surface a random uppercase acronym as the top cosine hit for that query). With hybrid the chunk containing `ECONNRESET` is at rank 1.
2. **Code-name recall.** Alex uploads `notes.md` with `LdapBindFailure` and `connectTimeout: 5000`. Searching "LdapBindFailure" returns the matching chunk. Searching "connectTimeout" returns the matching chunk. Both are lexical matches that dense embeddings partially blur.
3. **Long-tail identifier recall.** Taha uploads a CSV-derived chunk containing `pod/node-dockhoj-prod-7d4f9b8-zxq`. Searching that exact pod name returns the chunk; no need to remember the surrounding prose.
4. **Existing semantic queries still work.** A question like "summarize the auth chapter" still returns the auth chapter — RRF ranks the dense result top because it has no lexical competition, and dense recall is unchanged.
5. **Per-user visibility still enforced.** Alex's private chunks never surface to Taha's hybrid search. Lexical recall is filtered at the top-level fused step by the same `mergeWithVisibility()` clause used today.
6. **First-run after upgrade.** DocKhoj boots after Phase 05 is deployed. The migration runner scans existing chunks, backfills `searchText = payload.chunk` on every point, marks the flag in `app_metadata`. On the very next boot the flag is found and the migration is a no-op.
7. **Per-file deletion still works.** Taha deletes a file. Qdrant drops all chunks for that file (the existing `deleteByFilePath`) — lexical recall loses its `searchText` payload along with the rest. No orphan index entries.
8. **An empty corpus.** A user uploads nothing. Searches return no results, same as today. No new failure modes.

## Functional requirements

- **FR-1. `searchText` payload field.** Every chunk upserted by `src/services/qdrant.ts` after Phase 05 lands must include `payload.searchText = payload.chunk` (verbatim copy). Idempotent on re-upsert.
- **FR-2. `text` payload index.** `ensurePayloadIndexes` must create a `field_schema: 'text'` index on `searchText`, idempotent on re-boot. Existing `keyword` indexes for owner / visibility / filename etc. remain unchanged.
- **FR-3. One-shot backfill migration.** On boot after Phase 05 first lands, a one-shot function scans all points in `documents`, sets `payload.searchText = payload.chunk` on every point where `searchText` is missing, then writes the flag `phase_05_search_text_migration_applied` (timestamp) into the existing `app_metadata` collection (the one Phase 04 introduced). Subsequent boots read the flag and skip. The function mirrors `migratePayloads()` (qdrant.ts:281) line-for-line in shape — scroll + update + flag.
- **FR-4. `searchChunks` hybrid call.** `searchChunks` must switch from `client.query(name, { query: queryVector, filter, ... })` to `client.query(name, { prefetch: [...], query: { fusion: 'rrf' }, filter, ... })`, where `prefetch` contains exactly two entries: (a) dense cosine `{ query: queryVector, limit: prefetchLimit }` and (b) full-text `{ query: undefined, filter: { must: [{ key: 'searchText', match: { text: q } }] }, limit: prefetchLimit }`. Top-level `filter` is `mergeWithVisibility(buildSearchFilter(opts), viewerId)` and applies to the fused result. `prefetchLimit = Math.max(opts.limit ?? 5, 10) * 2`.
- **FR-5. Thread the query string.** Every caller that previously passed a vector to `searchChunks` must also pass the raw query text so the lexical prefetch has something to search on. Affects `routes/search.ts` (×2), `routes/chat.ts`, `services/stream-chat.ts`, `services/agent-loop.ts`. New signature: `searchChunks(vector, opts: SearchOptions & { query?: string }, viewerId?)`. `query` is **optional** — when absent the call falls back to a single dense prefetch (preserves `qdrant-visibility.test.ts` tests that don't care about recall).
- **FR-6. Per-file deletion still strips lexical index entries.** `deleteByFilePath` (qdrant.ts:556) drops the whole point — payload and any index entry that referenced it. No change required; the test must verify.
- **FR-7. Acceptance signature test.** `tests/services/qdrant.test.ts` (or a new sibling) must assert that a hybrid call to `searchChunks` issues a `client.query` whose first argument is the collection name and whose second argument contains `prefetch.length === 2`, `prefetch[0].query` is the dense vector, `prefetch[1].filter.must[0]` references `key: 'searchText', match: { text: q }`, and the top-level `query: { fusion: 'rrf' }`. Pure unit; mocks `client.query`.
- **FR-8. Acceptance e2e test.** A runnable curl flow, documented in `design.md` §"Testing strategy", that:
  - ingests a markdown file whose body contains the unique literal token `DOCKHOJ_HYBRID_TOKEN_<random>`,
  - asks `/api/search?q=DOCKHOJ_HYBRID_TOKEN_<random>` via the SPA-equivalent auth flow,
  - confirms the top-1 result is from that file.

## Non-functional requirements

- **NFR-1. No new dependencies.** `package.json` is unchanged in this phase. No `wink-bm25`, no `bm25s`, no `langchain`, no reranker client.
- **NFR-2. No new env vars.** The migration runs unconditionally on first boot after upgrade; nothing in `.env.example` changes.
- **NFR-3. Performance parity on existing queries.** The dense path is unchanged in shape; the added lexical prefetch is a single Qdrant full-text query against an indexed payload field. Total retrieval wall-clock on a 1000-chunk corpus must remain ≤ 2× pre-Phase-05 baseline, measured on a `./restart.sh` cold boot.
- **NFR-4. No regression on visible-behavior integration tests.** `qdrant-visibility.test.ts` (visibility scoping), `agent-loop.test.ts` (tool flow), `stream-chat.test.ts` (stream composition), `routes/search-auth.test.ts` (route auth) — all green without modification except where FR-5's signature ripples.
- **NFR-5. Backfill bounded memory.** The migration mirrors `migratePayloads` — `scroll(limit: 100, ...)` then `setPayload` per page; peak memory bounded to 100 points in transit.
- **NFR-6. Idempotent.** Re-running the migration on a volume where `searchText` is already set on every point is a no-op (the inner `if (!('searchText' in payload)) toUpdate.push(point.id)` gates it). The flag in `app_metadata` is the second idempotency gate.

## Out of scope
- **Sparse-vector channels (SPLADE, BGE-M3 sparse).** RRF-over-dense+lexical is the baseline; a learned sparse model would change the upsert path and add a dep — separate phase.
- **Rerankers (Cohere / Jina / cross-encoder).** Belong on top of an already-hybrid system; not in this phase.
- **Configurable RRF rankConstant, prefetch over-fetch factor, lexical-token-boost weight.** Hard-coded defaults; revisit when measured.
- **Removing dense-only fallback.** Stays; the only consumer today is the visibility test suite. Removing it would force a rewrite of `qdrant-visibility.test.ts` for no production reason.
- **Schema changes in SQLite.** No `.sql` migration files. This phase only touches Qdrant.
- **Per-tenant lexical indexes.** One global `text` index on `searchText`; per-tenant adds Qdrant collection count for zero current benefit.
- **API surface change.** No new endpoint, no new request / response field.
- **SPA changes.** None.
- **Document re-indexing.** Existing chunks are migrated in place. No `POST /api/admin/reindex` style endpoint.

## Constraints & assumptions
- **Qdrant version.** The Docker stack uses Qdrant `1.17.x` (per `package.json` + `docker-compose.yml` + the current working `app_metadata` collection pattern). Prefetch + RRF (`{ fusion: 'rrf' }`) and `field_schema: 'text'` payload indexes are both supported in 1.5+, so 1.17 is fine.
- **Embedding model.** Still `nomic-embed-text`, still 768-dim, still `VECTOR_SIZE` env default of 768. No model change.
- **Chunking strategy.** Still the Phase 01/03 structural chunker, 512-token max / 64-token overlap. Chunks already carry `payload.chunk` with raw text; `searchText` is set from that field verbatim.
- **Test surface.** Vitest runs in-process with mocked `client.query`. The full-text prefetch path cannot be exercised in-process without a real Qdrant; the unit test pins the call shape, the e2e curl flow exercises the behavior.

## Acceptance criteria
The phase is done when **every one** of the following holds:

1. **`searchText` on every chunk.** After `npm test -- --run`, the integration test that builds a chunk in-process and calls `upsertChunks` asserts the resulting Qdrant payload contains `searchText` equal to `chunk.payload.chunk`.
2. **Index created.** After `./restart.sh` cold boot, `curl http://localhost:6333/collections/documents` returns a payload schema that includes `searchText` with `text` index type.
3. **Migration runs once.** First boot after the upgrade populates `searchText` on every pre-existing chunk. A second boot reads the `app_metadata` flag and reports "already migrated" (matching the `qdrant-migration.test.ts` style assertion for `migratePayloads`).
4. **Hybrid query shape.** Unit test pins the `client.query` call as specified in FR-7.
5. **Lexical recall via curl.** Per the FR-8 e2e walkthrough, `GET /api/search?q=DOCKHOJ_HYBRID_TOKEN_<random>` returns the matching document in the first result after a manual ingest via `/api/upload`.
6. **Semantic recall still works.** A separate e2e curl — upload a PDF + ask "summarize the introduction" — returns semantically relevant chunks at the top (dense recall still dominates when there's no lexical competition).
7. **Visibility still enforced.** `qdrant-visibility.test.ts` green without modification. Cross-user private chunks never surface.
8. **`deleteByFilePath` still clean.** After `POST /api/documents/:id/delete`, the file's points are gone from Qdrant (including `searchText`); a search for a unique literal from that file returns no hits.
9. **All tests green.** `npm test -- --run` exits 0; no `.skip` added.
10. **`./restart.sh` green.** The script reports healthy on a cold boot (existing protocol in `CLAUDE.md` §"End-to-end testing protocol").

## Open questions
None at design time. Anything that surfaces during implementation gets added as a `**Blocker:**` line in the active task's TASKS entry, per the standing protocol in `~/.claude/CLAUDE.md` §10.
