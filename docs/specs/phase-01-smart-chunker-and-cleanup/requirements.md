# Requirements — Phase 01

## Purpose

Improve retrieval quality in DocKhoj by replacing the char-based, structure-blind chunker with a token-aware, block-aware splitter that preserves document structure (markdown headings, code fences, list items, PDF page boundaries) and carries rich metadata (heading path, page number, block kind) through to Qdrant. Add an optional embedding-similarity pass for long uniform sections. In the same change set, fix a list of identified bugs and quality issues from the codebase review (path traversal, XSS, memory leaks, Docker health, parallel embedding, payload indexes, MIME types, etc.).

The end state is a self-hosted RAG tool that:

1. Splits documents at meaningful boundaries, not at character 500 of a flattened string.
2. Returns citations that point to a *section*, not a sliding window.
3. Runs faster on large documents (parallel embedding).
4. Has no known security holes at the routes / UI layer.
5. Has enough test coverage that future agents can change the chunker without breaking retrieval silently.

## Users / actors

- **End user** — uploads documents, runs queries, reads answers and citations. Cares about answer correctness and citation precision.
- **Operator** — runs DocKhoj in Docker or on a host. Cares about graceful startup (waits for Ollama), graceful shutdown, and predictable resource use.
- **Future agent / contributor** — picks up the code after us. Cares about tests, naming, and structure.

## Use cases

| # | Flow | Acceptance signal |
|---|---|---|
| U1 | Upload a markdown file with multiple `##` sections and a fenced code block. Query about a section. | Top result's `headingPath` matches the queried section; the fenced code block is in a single chunk, not split across two. |
| U2 | Upload a 5-page PDF. Query for content on page 3. | Top result's `pageNumber` is 3. |
| U3 | Upload a long markdown doc with one heading spanning ~3 KB of prose. | Long section is split via the semantic-split pass (when enabled) near the topic shift; both halves remain under the token cap. |
| U4 | Hit `/download/..%2F..%2Fetc%2Fpasswd`. | Returns 404 (path traversal blocked). |
| U5 | LLM answer contains `<script>alert(1)</script>` injected via adversarial prompt or malformed doc. | UI does **not** execute the script; the markup is sanitized before render. |
| U6 | Send `/chat` with `sessionId` of 10 MB. | Server rejects with 400; memory is not consumed. |
| U7 | `docker compose up`. App container starts; first embed attempt succeeds (Ollama is healthy before app starts). | No "Ollama not ready" errors in logs. |
| U8 | Send `SIGTERM` to the running app. | In-flight requests complete or fail gracefully; `initCollection` and any pending uploads are not silently cut. |
| U9 | Upload 50 small files in batch. | Each file's status (success / failure with reason) is in the response; the upload uses bounded parallel embedding. |
| U10 | Query "what does Section 3.2 say about X?" against a long markdown doc. With `expand=sections`. | The response includes all chunks under heading "Section 3.2", not just the highest-scoring one. |
| U11 | Query for a fact that straddles two chunks (e.g. a sentence ending in chunk N and continuing in chunk N+1). With `expand=siblings`. | Both chunks are returned together; the LLM sees the full sentence. |
| U12 | Same query as U10, but the secondary section-expansion fetch fails (Qdrant blip). | The request still returns the original top-K hits; a warning is logged; no 5xx. |

## Functional requirements

### Parsing

- **FR-1** Parser MUST NOT collapse newlines before chunking. The current `text.replace(/\s+/g, ' ').trim()` in `src/services/parser.ts:40` is removed.
- **FR-2** Parser MUST emit a structured `ParsedBlock[]` view for `.md` / `.markdown`, `.pdf`, `.docx`, and `.txt` inputs.
- **FR-3** For `.md` / `.markdown`, the parser MUST identify blocks of kinds: `heading`, `paragraph`, `code`, `list`, `table`, `quote`, and assign each an inherited `headingPath` (e.g. `['Chapter 1', 'Section 1.2']`).
- **FR-4** For `.pdf`, the parser MUST preserve page boundaries; each block carries a `pageNumber` (1-indexed) and the document carries a `totalPages`.
- **FR-5** For `.docx`, the parser MUST extract paragraphs and basic structure (heading styles when present) and at minimum keep the document from collapsing to one line.
- **FR-6** For `.txt`, the parser MUST split on blank lines into paragraphs; structure-inferred.
- **FR-7** The returned `ParsedDocument` MUST keep a `text` field (concatenated plain text) for legacy callers and downstream consumers that don't yet consume `blocks`.

### Chunking

- **FR-8** The chunker MUST consume `ParsedBlock[]`, not a single string, and produce `Chunk[]`.
- **FR-9** Chunk size MUST be expressed in **tokens**, not characters. Default `CHUNK_MAX_TOKENS = 512`.
- **FR-10** Overlap MUST be expressed in tokens, default `CHUNK_OVERLAP_TOKENS = 64`.
- **FR-11** The chunker MUST enforce a minimum chunk size (default `CHUNK_MIN_TOKENS = 32`) — never produce a sub-token chunk; undersized trailing chunks are merged into the previous chunk.
- **FR-12** The chunker MUST NOT split inside a fenced code block. If a code block would overflow the cap, the preceding content flushes first, and the code block is split on its own internal line boundaries into multiple chunks, each still capped.
- **FR-13** The chunker MUST NOT split inside a single list item's continuation lines. A list is treated as one block for boundary purposes.
- **FR-14** Each emitted `Chunk` MUST carry metadata: `fileName`, `filePath`, `fileType`, `chunkIndex`, `totalChunks`, `blockKind` (primary kind), `headingPath`, `pageNumber?`, `tokenCount`, `startOffset`, `endOffset`.
- **FR-15** Overlap MUST be aligned to sentence boundaries on both ends (leading edge: advance over whole sentences until overlap budget consumed; trailing edge: start at a sentence boundary if possible).
- **FR-16** The chunker MUST support an optional **semantic-split pass** (`CHUNK_SEMANTIC_SPLIT=true`, **default `true`** per user decision) that, for chunks exceeding `softMaxTokens = 1.5 * maxTokens`, finds a local cosine-similarity minimum between adjacent embedded windows and splits there. Recursion depth capped at 2 to prevent runaway.
- **FR-17** Sentence detection MUST handle abbreviations (`Mr.`, `e.g.`, `U.S.A.`), decimal numbers, and non-ASCII punctuation (`。`, `!`, `?`).

### Embedding

- **FR-18** `embedTexts` MUST run requests in parallel with a bounded concurrency cap (`EMBEDDING_CONCURRENCY`, default 4).
- **FR-19** `isOllamaAvailable()` MUST actually probe Ollama (`GET /api/tags` with a short timeout) and return the real result. No more hardcoded `true`.
- **FR-20** Embedding errors MUST be retried with exponential backoff (3 attempts, base 250 ms, jittered) for transient failures (network, 5xx). Non-retriable errors (4xx) fail immediately.

### Qdrant / storage

- **FR-21** `initCollection` MUST create payload indexes on `fileName`, `filePath`, `fileType`, and `pageNumber` (where applicable) so filtered search is supported.
- **FR-22** `searchChunks` MUST accept optional filters: `fileName`, `fileType`, `pageNumber`.
- **FR-23** `client.search` MUST be migrated to `client.query` (modern API).

### Routes

- **FR-24** `/upload` and `/upload/batch` MUST share a single processing pipeline (extracted function), differing only in input parsing and response shape.
- **FR-25** `/upload/batch` MUST return per-file status: `{ fileName, fileId, status: 'success' | 'failed', chunksIndexed?, error? }`.
- **FR-26** `/download/:filename` MUST reject path traversal (resolved path stays inside `FILES_DIR`) and return 404 otherwise.
- **FR-27** `/download/:filename` MUST return correct MIME types: `.pdf` → `application/pdf`, `.docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `.md` / `.markdown` → `text/markdown`, `.txt` → `text/plain`, fallback `application/octet-stream`.
- **FR-28** `/chat` MUST validate `sessionId` (1–64 chars, `[A-Za-z0-9_-]`) and reject otherwise with 400.
- **FR-29** `/chat` MUST bound conversation history length per session (`CHAT_HISTORY_MAX_TURNS`, default 20 turns). Older turns are evicted (FIFO).
- **FR-30** `/search` and `/search/rag` MUST accept optional `fileName` and `fileType` query parameters and pass them to Qdrant as filters.
- **FR-30a** `/search`, `/search/rag`, and `/chat` MUST accept an optional `expand` query parameter with values `none` (default), `siblings`, or `sections`. The default is `none` (current behavior).
- **FR-30b** `expand=siblings` MUST, for each top-K hit, fetch the hit's neighboring chunks from the same `filePath` (range `chunkIndex ± 2`), dedupe across hits, and return the expanded set capped at 15 chunks total.
- **FR-30c** `expand=sections` MUST, for each top-K hit, fetch all chunks from the same `filePath` sharing the same `headingPath` (deduped across hits), and return the expanded set capped at 20 chunks total.
- **FR-30d** The expansion MUST preserve the original hit order when interleaving expanded neighbors with the original hits; siblings come immediately adjacent to their triggering hit; section chunks come after all direct hits.
- **FR-30e** Expanded chunks MUST carry the same metadata fields as direct hits (`headingPath`, `pageNumber`, `blockKind`) so citations are uniform.
- **FR-30f** When the expansion fetch fails (e.g. Qdrant timeout on the secondary query), the system MUST fall back to returning only the original hits and log a warning; it MUST NOT fail the request.
- **FR-31** App MUST shut down gracefully on `SIGTERM` / `SIGINT`: stop accepting new requests, wait for in-flight to finish (max 30 s), then exit.
- **FR-32** Logged chunk payloads MUST be truncated to `LOG_CHUNK_PREVIEW_CHARS` (default 200).

### UI

- **FR-33** LLM responses in the UI MUST be sanitized (DOMPurify or equivalent) before being inserted via `innerHTML`.
- **FR-34** File uploads from the UI MUST run in parallel (bounded by browser connection limits — at minimum not strictly sequential).

### TypeScript / tooling

- **FR-35** `tsconfig.json` MUST set `noImplicitAny: true`; any resulting errors fixed (not suppressed).
- **FR-36** `tsconfig.json` SHOULD set `noUncheckedIndexedAccess: true`; any resulting errors fixed.
- **FR-37** Dead code MUST be removed: `combineChunks`, unused `path` import in logger, unused `v4 as uuidv4` import in qdrant.
- **FR-38** Logger child `donwloadLog` MUST be renamed to `downloadLog` and references updated.
- **FR-39** All new dependencies MUST be on the project allowlist (MIT / Apache / BSD).

### Docker

- **FR-40** `Dockerfile` MUST include `HEALTHCHECK` against the running app's `/health`.
- **FR-41** `docker-compose.yml` MUST add an Ollama healthcheck (`/api/tags` reachable) and the app MUST depend on `ollama: service_healthy` (not `service_started`).
- **FR-42** `docker-compose.yml` MUST default `OPENAI_BASE_URL` to `https://api.openai.com/v1` so users don't need to set it explicitly.
- **FR-43** `Dockerfile` EXPOSE MUST match the port the app actually listens on (`3001` per compose / env).

### Tests

- **FR-44** Tests MUST cover: each parser (markdown, pdf, docx, txt), tokenizer wrapper, structural chunker, semantic-split pass, embed batching, Qdrant wrapper (mocked client), each route (via `fastify.inject`), and one end-to-end test that uploads a sample markdown doc and queries it.
- **FR-45** `tests/utils/chunk.test.ts` MUST be updated to cover the new structured API; legacy char-based tests are removed or migrated.

## Non-functional requirements

- **NFR-1** — Chunking + embedding time on a 1 MB markdown document MUST be ≤ 2× the current implementation. (Parallel embedding should keep this in check.)
- **NFR-2** — Backward compatibility for stored chunks: existing Qdrant records lacking `blockKind` / `headingPath` / `pageNumber` remain queryable; new chunks add fields.
- **NFR-3** — Test coverage: chunker code paths ≥ 90%, parser code paths ≥ 90%, project overall ≥ 80% line coverage.
- **NFR-4** — All new dependencies MIT / Apache / BSD.
- **NFR-5** — No `console.log` / `debug print` left in production code.
- **NFR-6** — No commented-out code committed.

## Out of scope (this phase)

- Hierarchical / parent-child chunk storage (separate vectors for section vs passage).
- Multi-modal extraction (PDF images, OCR).
- Cross-encoder re-ranking of retrieved chunks.
- Streaming chat responses (SSE).
- Authn / authz / multi-tenancy.
- A document deletion endpoint (point by id exists; doc-level delete does not — deferred).
- Migration script for legacy chunks (back-compat is by absence of new fields, not by rewrite).
- Production-grade retry / circuit breaker around Qdrant (FR-20 covers Ollama; Qdrant gets simple retry only on `ECONNRESET`).

## Constraints & assumptions

- **Embedding model**: `nomic-embed-text` (768 dims, 8192 token context). Tokenizer mismatch with `cl100k_base` (used by `gpt-tokenizer`) is acceptable for sizing decisions — chunking budgets are conservative (512 default) and well below the model's limit.
- **Stack**: Node 20+, Fastify 5, Qdrant 1.x, Ollama (current). No new runtime services.
- **Single-instance assumption**: chat history remains in-memory (FR-29 bounds it). Persisting across restarts is a future phase.
- **No breaking API changes to the response shape of existing endpoints** (`/search`, `/search/rag`, `/chat`, `/upload`, `/files`); only additions.

## Acceptance criteria

The phase is done when **all** of the following are true:

1. `npm run build` succeeds with `noImplicitAny: true`.
2. `npm test` passes with coverage ≥ 80% lines overall and ≥ 90% in chunker/parser modules.
3. A markdown document with headings + code fences + lists, when uploaded and queried, returns chunks where:
   - At least one chunk has `blockKind: 'code'`, `headingPath: [...]` non-empty, and the chunk's text equals the original fenced block verbatim.
   - Chunks that span a list do not split a single list item.
4. A PDF (real or fixture) with 3+ pages, when uploaded and queried, returns chunks with `pageNumber` matching the source page for at least one chunk.
5. The semantic-split test (FR-16) constructs a document with a known topic shift and verifies the split lands near it.
6. Path traversal request to `/download` returns 404.
7. Batch upload returns per-file status with errors included.
8. UI sanitizes LLM output (XSS test passes).
9. App shuts down gracefully on SIGTERM (test asserts `app.close()` is called within a timeout).
10. Docker Compose starts the app and `HEALTHCHECK` passes on first boot (verified locally with `docker compose up` + `docker compose ps` showing healthy).
11. Reviewer (the user) has signed off on `design.md` and the `TASKS.md` plan.

## Open questions (need user input before / during implementation)

- **OQ-1** — Backward compat for `CHUNK_SIZE` / `CHUNK_OVERLAP` env vars (currently char-based). Options:
  - (a) Treat legacy values as token counts. (Semantically wrong but a no-op migration.)
  - (b) Rename to `CHUNK_MAX_TOKENS` / `CHUNK_OVERLAP_TOKENS`, drop the old names, document the change in README. (Clean break, but breaks anyone with the old env vars set.)
  - (c) Accept both: prefer the new names if set, fall back to the old, but interpret old as chars and warn. (Compromise.)
  - **Recommendation: (b). The old values are misleading regardless.**
- **OQ-2** — Semantic split default. **Decision: on by default** (`CHUNK_SEMANTIC_SPLIT=true`). Users pay extra embedding cost at index time for better retrieval. The cost is bounded: only chunks exceeding `softMaxTokens` are split, and recursion depth is capped.
- **OQ-3** — Markdown parser: `unified`+`remark-parse` (real AST, MIT, ~150 KB), or roll a small custom block parser to keep deps small?
  - **Recommendation: `unified`+`remark-parse`. Edge cases (nested lists, code fence detection, table support) are non-trivial to roll by hand.**
- **OQ-4** — `/chat` history: when over the cap, evict FIFO (oldest first), or trim the head and keep system context? FIFO is simpler and matches "bounded memory"; trimming can keep an opening turn.
  - **Recommendation: FIFO eviction.**
- **OQ-5** — DOMPurify in the UI: CDN (`https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js`) or vendored? CDN is fine for a self-hosted tool but adds a runtime dep on a third party.
  - **Recommendation: CDN for now; revisit if offline-first matters.**