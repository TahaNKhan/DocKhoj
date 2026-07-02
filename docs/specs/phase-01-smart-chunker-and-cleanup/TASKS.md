# Tasks — Phase 01

**Phase:** Smart Chunker & Cleanup
**Spec:** [`README.md`](./README.md), [`requirements.md`](./requirements.md), [`design.md`](./design.md)
**Status:** done (per spec README + git log `9bb6cf3` … `014a4f2`)

---

## T1 — Add new dependencies

- **Description:** Install `gpt-tokenizer`, `unified`, `remark-parse`, `mdast-util-to-string`, `p-limit` (all MIT). Verify lockfile resolves cleanly.
- **Maps to FR:** FR-39
- **Maps to design:** §Tech stack
- **Acceptance:** `npm install` succeeds; `package.json` lists new deps; lockfile updated.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T2 — Structured parser (markdown, txt, docx, pdf)

- **Description:** Create `parser-types.ts` (`ParsedBlock`, `BlockKind`, `ParsedDocument`). Implement `parser-markdown.ts` (uses `unified`+`remark-parse` to walk the AST and emit blocks with `headingPath`); `parser-text.ts` (split on blank lines); `parser-docx.ts` (paragraphs from `mammoth`); `parser-pdf.ts` (preserves page boundaries via per-page extraction). Rewrite `services/parser.ts` dispatcher. Populate the legacy `text` field by concatenating block texts with single newlines.
- **Maps to FR:** FR-1 … FR-7
- **Maps to design:** §Key algorithms > Markdown parsing
- **Acceptance:** Unit tests for each parser pass; `ParsedDocument.text` is non-empty for all supported inputs; `blocks[]` is non-empty and has correct kinds; markdown parser produces a `headingPath`; PDF parser produces `pageNumber`.
- **Depends on:** T1
- **Estimate:** L
- **Status:** done

## T3 — Tokenizer + sentence splitter

- **Description:** Implement `chunk-tokenizer.ts`: `countTokens(text)`, `splitOnSentences(text)` (handles ASCII `.`/`!`/`?`, full-width `。`/`！`/`？`, abbreviations, decimal numbers, Unicode line breaks), `takeLastSentences(text, budgetTokens)`, `takeFirstSentences(text, budgetTokens)`.
- **Maps to FR:** FR-17
- **Maps to design:** §Key algorithms > Sentence-aligned overlap
- **Acceptance:** Unit tests cover abbreviations (`Mr.`, `e.g.`, `U.S.A.`), decimals (`3.14`), full-width punctuation, and a sentence starting after a newline; tokenizer count is monotonic with input length.
- **Depends on:** T1
- **Estimate:** M
- **Status:** done

## T4 — Structural chunker

- **Description:** Implement `chunk-structural.ts`. Block-list → candidate chunks. Enforces max/min tokens. Never splits a code block or a single list item. Sends overlap into the next chunk aligned to sentence boundaries. Emits `Chunk[]` with full metadata.
- **Maps to FR:** FR-8 … FR-15
- **Maps to design:** §Key algorithms > Structured chunking
- **Acceptance:** Unit tests:
  - Code block of 1500 tokens is split into multiple chunks, each ≤ maxTokens, no line is broken across chunks.
  - List of 1500 tokens is split into chunks without splitting an individual list item.
  - Overlap text on chunk N+1 starts with whole sentences from chunk N.
  - Trailing chunk shorter than `minTokens` is merged into the previous chunk.
  - A chunk's `headingPath` reflects the most recent heading(s).
- **Depends on:** T2, T3
- **Estimate:** L
- **Status:** done

## T5 — Semantic-split pass (optional)

- **Description:** Implement `chunk-semantic.ts`. For chunks exceeding `softMaxTokens`, embed adjacent windows of `maxTokens/2` (step `maxTokens/4`), find cosine-similarity minimum, split there. Recursion capped at `semanticMaxDepth` (default 2).
- **Maps to FR:** FR-16
- **Maps to design:** §Key algorithms > Semantic split
- **Acceptance:** Test constructs a document with a known topic shift (e.g. cooking → sports) and asserts the split index falls within ±2 windows of the known shift.
- **Depends on:** T4, T7 (needs embedText for the test)
- **Estimate:** M
- **Status:** done

## T6 — Public chunk API + legacy shim

- **Description:** Rewrite `utils/chunk.ts` to export `chunkBlocks(blocks, opts)` and keep `chunkText(text, opts)` as a shim that wraps text in a single paragraph-kind block then calls `chunkBlocks`. Update existing `tests/utils/chunk.test.ts` to cover the new API; migrate legacy assertions.
- **Maps to FR:** FR-8, FR-45
- **Maps to design:** §Module layout
- **Acceptance:** `chunkText` still works for the `upload.ts` call site with the new options shape; legacy tests are replaced with equivalent tests against the new API; `npm test` green.
- **Depends on:** T4
- **Estimate:** M
- **Status:** done

## T7 — Embed service: parallel + retry + real health check

- **Description:** Rewrite `services/embed.ts`. `embedTexts` uses `p-limit(EMBEDDING_CONCURRENCY)`. `embedTextWithRetry` retries 3x with exponential backoff (250 ms, 500 ms, 1000 ms + jitter) on network errors and 5xx. `isOllamaAvailable()` pings `/api/tags` with a 2 s timeout and returns the real result.
- **Maps to FR:** FR-18, FR-19, FR-20
- **Maps to design:** §Key algorithms > Embedding parallelism
- **Acceptance:** Tests assert: `embedTexts` runs N requests with ≤ concurrency in flight at any time (use a counting mock); retry happens on 5xx then succeeds; `isOllamaAvailable` returns `false` when fetch throws and `true` on 200.
- **Depends on:** T1
- **Estimate:** M
- **Status:** done

## T8 — Qdrant service: payload indexes + filters + client.query

- **Description:** In `services/qdrant.ts`, create payload indexes for `fileName` (keyword), `filePath` (keyword), `fileType` (keyword), `pageNumber` (integer) in `initCollection`. Migrate `searchChunks` to `client.query`. Add optional filter args (`fileName`, `fileType`, `pageNumber`). Update `DocumentChunk` payload type with new metadata fields.
- **Maps to FR:** FR-21, FR-22, FR-23
- **Maps to design:** §Key algorithms > Qdrant client migration
- **Acceptance:** Tests with a mocked Qdrant client verify: `createPayloadIndex` called for each field; `searchChunks` builds correct filter; `client.query` is called (not `client.search`).
- **Depends on:** —
- **Estimate:** M
- **Status:** done

## T9 — Upload routes: dedup + per-file status + parallel embed

- **Description:** Extract shared pipeline (`processUpload(filePath, fileName)` returning `{ status, chunksIndexed, error? }`). `/upload` calls it once; `/upload/batch` calls it per file and returns per-file results. Use `embedTexts` with bounded concurrency. Log only a truncated chunk preview.
- **Maps to FR:** FR-24, FR-25, FR-32
- **Maps to design:** §Module layout
- **Acceptance:** Tests via `fastify.inject`: single upload returns `{ success, chunksIndexed }`; batch upload returns `files: [{ status, chunksIndexed?, error? }]` with failures surfaced; on parse error in single mode the file is deleted; logged payload's `chunk` field is ≤ `LOG_CHUNK_PREVIEW_CHARS`.
- **Depends on:** T7, T8
- **Estimate:** M
- **Status:** done

## T10 — Download route: traversal guard + MIME map

- **Description:** Implement path-traversal guard using `path.basename` + `path.resolve` containment check. Replace ad-hoc content-type assignment with a MIME map for `.pdf`, `.docx`, `.md`, `.markdown`, `.txt`, with `application/octet-stream` fallback.
- **Maps to FR:** FR-26, FR-27
- **Maps to design:** §Key algorithms > Path-traversal guard
- **Acceptance:** Tests: traversal request returns 404; PDF download returns `application/pdf`; DOCX returns the OOXML MIME; MD returns `text/markdown`; TXT returns `text/plain`; unknown extension returns `application/octet-stream`.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T11 — Chat route: sessionId validation + history cap

- **Description:** Validate `sessionId` matches `^[A-Za-z0-9_-]{1,64}$`; reject with 400 otherwise. Bound history per session to `CHAT_HISTORY_MAX_TURNS` (default 20) using FIFO eviction.
- **Maps to FR:** FR-28, FR-29
- **Maps to design:** §Module layout
- **Acceptance:** Tests: invalid sessionId → 400; over-cap session history never exceeds the limit.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T12 — Search route: filter query params + context expansion

- **Description:** Accept optional `fileName` and `fileType` query params on `/search` and `/search/rag`, plus `expand=none|siblings|sections` (default `none`). Pass fileName/fileType through to `searchChunks` as filters. Implement `expandHits(hits, mode)` in `services/qdrant.ts` using filter-only `client.query` calls. Wire it into the route handlers and `/chat`. Result items include `headingPath`, `pageNumber`, `blockKind` when present in payload. Expansion fetch failures fall back to original hits + warning log.
- **Maps to FR:** FR-30, FR-30a … FR-30f
- **Maps to design:** §Context expansion
- **Acceptance:** Tests: query with `fileName=foo.pdf` builds a Qdrant filter containing the field; `expand=siblings` triggers neighbor fetch and respects the 15-cap; `expand=sections` triggers headingPath fetch and respects the 20-cap; secondary fetch failure returns original hits and logs warning (no 5xx).
- **Depends on:** T8
- **Estimate:** M
- **Status:** done

## T13 — Index: graceful shutdown

- **Description:** Register `SIGTERM` and `SIGINT` handlers that call `fastify.close()` with a 30 s deadline, then `process.exit(0)` (or `1` on error). Idempotent (signal during shutdown is a no-op).
- **Maps to FR:** FR-31
- **Maps to design:** §Key algorithms > Graceful shutdown
- **Acceptance:** Test sends SIGTERM in a child process and asserts the process exits within 35 s with code 0.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T14 — Public UI: DOMPurify + parallel uploads

- **Description:** Add DOMPurify CDN script. Wrap `marked.parse(data.answer)` with `DOMPurify.sanitize`. Change file upload loop in `handleFiles` to `Promise.all` (or bounded concurrency).
- **Maps to FR:** FR-33, FR-34
- **Maps to design:** §Module layout
- **Acceptance:** Static check that the script tag is present and `DOMPurify.sanitize` is called around `marked.parse`. Manual test in browser confirms a synthetic `<script>`-containing answer does not execute.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T15 — Logger: rename + truncate + remove unused

- **Description:** Rename `donwloadLog` → `downloadLog` in `utils/logger.ts`. Remove the unused `path` import. Add a helper `truncate(text, max)` used by upload routes to log only a chunk preview. Update all import sites.
- **Maps to FR:** FR-32, FR-37, FR-38
- **Maps to design:** §Module layout
- **Acceptance:** No references to `donwloadLog` remain; `utils/logger.ts` doesn't import `path`; `npm test` green.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T16 — tsconfig + dead code

- **Description:** Set `noImplicitAny: true` and `noUncheckedIndexedAccess: true`. Fix all resulting type errors (do not suppress with `// @ts-ignore`). Remove `combineChunks` from `utils/chunk.ts`. Remove unused `uuid` import in `services/qdrant.ts`.
- **Maps to FR:** FR-35, FR-36, FR-37
- **Maps to design:** §Deployment
- **Acceptance:** `npm run build` passes with the new strict flags; `combineChunks` is gone; `uuid` import is gone from qdrant.ts.
- **Depends on:** T6
- **Estimate:** M
- **Status:** done

## T17 — Route tests via fastify.inject

- **Description:** Add `tests/routes/upload.test.ts`, `download.test.ts`, `chat.test.ts`, `search.test.ts`. Use `fastify.inject` with mocked Ollama + Qdrant boundary. Cover happy path, the new validation/framing requirements, and the `expand=none|siblings|sections` matrix.
- **Maps to FR:** FR-24 … FR-30 (tests), FR-30a … FR-30f (tests)
- **Maps to design:** §Testing strategy
- **Acceptance:** All route tests green; each route has at least one happy-path + one validation test; expansion tests cover all three modes plus the failure-fallback path.
- **Depends on:** T9, T10, T11, T12
- **Estimate:** M
- **Status:** done

## T18 — E2E upload-and-query test

- **Description:** `tests/e2e/upload-and-query.test.ts`. Build the app, inject an upload of a sample markdown document (with headings + fenced code + a list), inject a search query that targets a known phrase, assert the top result has the expected `headingPath`, the code block is intact, and the list item is not split.
- **Maps to FR:** FR-44
- **Maps to design:** §Testing strategy
- **Acceptance:** E2E test green; demonstrates the chunker improvement end-to-end.
- **Depends on:** T2, T4, T6, T7, T8, T9, T12
- **Estimate:** M
- **Status:** done

## T19 — Docker: HEALTHCHECK + Ollama wait + env defaults

- **Description:** `Dockerfile`: add `HEALTHCHECK CMD wget ... /health`; change `EXPOSE 3001`. `docker-compose.yml`: add Ollama healthcheck; change app's `depends_on` to `service_healthy`; default `OPENAI_BASE_URL` to `https://api.openai.com/v1`.
- **Maps to FR:** FR-40, FR-41, FR-42, FR-43
- **Maps to design:** §Deployment
- **Acceptance:** `docker compose config` validates; `docker compose up` brings all three services to `healthy`.
- **Depends on:** T13
- **Estimate:** S
- **Status:** done

## T20 — Coverage thresholds + bring coverage up

- **Description:** Add thresholds to `vitest.config.ts` (lines 80, functions 80, branches 75; chunk-* and parser-* lines 90). Run coverage; add tests for any under-covered module until thresholds are met.
- **Maps to FR:** FR-3, FR-44
- **Maps to design:** §Testing strategy
- **Acceptance:** `npm run coverage` exits 0 with thresholds met.
- **Depends on:** T17, T18
- **Estimate:** M
- **Status:** done

## T21 — Final verification + README

- **Description:** Run `npm run build`, `npm test`, `npm run coverage`, `docker compose config`. Update README with the new env vars, the removal of `CHUNK_SIZE`/`CHUNK_OVERLAP`, the new chunking model, and the semantic-split opt-in.
- **Maps to FR:** all (verification)
- **Maps to design:** §Deployment
- **Acceptance:** Build, test, coverage all green; `docker compose config` valid; README accurately documents new behavior.
- **Depends on:** T1 … T20
- **Estimate:** S
- **Status:** done

---

## Notes

- Phase 01 task entries are historical record. Their `Status:` fields reflect the spec README (`done`); consult the git log for commit-level detail.
- Phase 01 ships the foundational chunker rewrite that all later phases build on. No code under `src/chunker/*` was renamed in Phase 02; the `utils/chunk*.ts` files in `src/utils/` are Phase 01's load-bearing chunker.