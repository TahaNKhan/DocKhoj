# Requirements — Phase 03

## Purpose

Close the two most-requested gaps in the Phase 02 system: **the inability to remove a document after it's been indexed** (deferred from Phase 01) and **the inability for the LLM to pull additional context on its own** (deferred from Phase 02 as "LLM tool-use agent loop").

After this phase:

1. A user can see every document they've uploaded, know how many chunks each has produced, and delete one (or many) when they no longer want it indexed. Deletion removes all of the document's chunks from Qdrant, the file from disk, and the metadata row from SQLite — atomically-enough that the system never returns a half-deleted state.
2. A user can opt into agentic RAG (`expand=auto`) and watch the LLM call retrieval tools in real time — fetching neighbor chunks, section chunks, individual chunks, or document metadata — before producing its final answer. The loop is bounded (3 iterations, 10K-token tool-result cap per iteration) so it can't run away. The assistant message records what tools were called so the user can audit the reasoning.

## Users / actors

- **End user** — uses DocKhoj daily. Cares about:
  - **Document deletion:** "I uploaded `notes.md` last week and now I don't want it in my searches. I should be able to delete it and know it's gone." Sees a "Documents" list, sees chunk counts, can delete with confidence (confirmation, undo not required but a clear final state).
  - **Agentic RAG:** "I asked about 'how does the auth flow work in chapter 2' and the LLM only saw a slice. I want it to go fetch the rest of chapter 2 before answering." Sees tool-call chips below the assistant bubble. Doesn't have to do anything to trigger it — toggles "Auto" in the toolbar.

- **Operator** — runs DocKhoj in Docker. Cares about:
  - Document deletion doesn't leave orphan files, orphan chunks, or orphan rows. Restart-survivable. WAL still works.
  - Agentic RAG doesn't blow up the LLM context window. Loop bounds are honored. Tool-result text is token-capped.

- **Future agent / contributor** — picks up the code after us. Cares about:
  - The agent loop is testable with a stubbed OpenAI client (no live LLM calls in unit tests).
  - The tool implementations are pure functions over existing services (no business logic in the route handler).
  - The new SQLite columns have a migration that re-applies cleanly on a fresh volume.

## Use cases

| # | Flow | Acceptance signal |
|---|---|---|
| U1 | Open `/upload` after indexing three docs. | A "Documents" section below the queue lists the three docs with their filenames, file-type chips, chunk counts, upload timestamps, and delete buttons. |
| U2 | Click delete on `notes.md`. | An inline confirm appears (or a confirmation modal). On confirm, the row disappears optimistically; on success, the row stays gone; on failure, the row reappears with an inline error. |
| U3 | After delete, query `/api/search?q=notes` for a phrase that was in `notes.md`. | The deleted chunks are gone from Qdrant; the search returns nothing matching the deleted file (other docs still searchable). |
| U4 | After delete, restart the container (`docker compose restart app`). | The deleted doc is still gone — no resurrection from SQLite, no orphan file on disk, no orphan row in `documents`. |
| U5 | Open `/chat`, toggle the toolbar from "None" to "Auto". | The chip becomes "Auto"; the next chat message uses the agentic loop. |
| U6 | With "Auto" on, ask "What does chapter 2 of notes.md say about authentication?". | The LLM calls `get_section_chunks(notes.md, ["Chapter 2"])`, sees the result, and produces an answer. The user sees a `get_section_chunks` chip below the bubble with arguments and result preview. |
| U7 | With "Auto" on, ask a question where the LLM doesn't need extra context. | No tool calls are made; the response is identical to `expand=none`. |
| U8 | With "Auto" on, ask a question that triggers many retrievals. | The agent loop terminates after `MAX_AGENT_ITERATIONS` (3) iterations or earlier if the LLM returns a final answer. The `iterations` field on the persisted assistant message records how many rounds ran. |
| U9 | With "Auto" on, send a 20-page PDF, ask a 500-token question. | Tool results are token-capped at 10K total per iteration. The cap is applied incrementally across tool calls within an iteration (not reset per call). |
| U10 | With "Auto" on, close the tab mid-agent-loop. | Server detects disconnect within one event-loop tick (existing Phase 02 behavior); the in-flight OpenAI stream is aborted; partial tool-call state is discarded; no orphan LLM call observed in the provider dashboard. |
| U11 | With "Auto" on, send a question when LLM provider doesn't support `tools`. | The server falls back to non-agentic behavior (the same as `expand=none`) and emits no `tool_call` events. The `tool_calls` column on the persisted message is null. Logged at `warn` level. |
| U12 | Toggle back to "None". | Subsequent messages revert to non-agentic behavior. No leftover state. |
| U13 | `curl http://host/api/documents` after indexing three docs. | Returns `[{fileId, fileName, fileType, chunkCount, bytes, uploadedAt}, ...]`, most-recent-first. |
| U14 | `curl -X DELETE http://host/api/documents/<fileId>` after the row is already deleted. | Returns 404 JSON (the SQLite row is gone; treat as "already gone", not a server error). |
| U15 | `curl http://host/api/documents/<bogus-id>`. | Returns 404 JSON (fileId not found). |
| U16 | `curl http://host/api/status` after Phase 03 lands. | Returns `{chunks, ollamaAvailable, llmModel, llmContextSize, documents}`. The `documents` field is the count of rows in the new `documents` table. |
| U17 | `curl -N -X POST http://host/api/chat/stream -d '{"q":"...","expand":"auto"}'`. | The SSE stream emits `event: meta, sources, token*, tool_call*, tool_result*, done` (the `tool_*` events only when the LLM calls tools). |
| U18 | Upload two files with the same original filename (e.g. `notes.md`) in succession. | Both appear in the documents list with distinct `fileId`s. Deleting one does not affect the other. |
| U19 | Hit the agent loop with a stubbed LLM that returns malformed `tool_calls` (missing `id`, unparseable `arguments`). | Server logs at `warn` level, falls back to the existing error path: the partial assistant text is persisted, the agent loop is terminated, an `event: error` is emitted. No infinite loop. |
| U20 | Container restart while an agentic chat is mid-loop (with the same restart timing as Phase 02's persistence tests). | Server restart is fine; the in-flight stream is aborted (Fastify closes it on shutdown); the partial assistant message is discarded (same as Phase 02 behavior). No tool calls persist. |

## Functional requirements

### Document deletion

- **FR-1** The server MUST persist a row in a new `documents` SQLite table for every successful upload. Columns: `file_id` (TEXT PRIMARY KEY, UUIDv4), `file_name` (TEXT NOT NULL), `file_type` (TEXT NOT NULL, lower-case extension), `bytes` (INTEGER NOT NULL), `uploaded_at` (TEXT NOT NULL, SQLite `datetime('now')`), `chunk_count` (INTEGER NOT NULL).
- **FR-2** The new table MUST be created by migration `003_documents.sql`. Migrations apply on server startup, idempotently, before `initCollection()` (same order as the existing migrations).
- **FR-3** `GET /api/documents` MUST return `[{fileId, fileName, fileType, chunkCount, bytes, uploadedAt}, ...]` ordered by `uploaded_at DESC` (most-recently-uploaded first). Returns `[]` if the table is empty. No pagination in this phase.
- **FR-4** `DELETE /api/documents/:fileId` MUST:
  - Validate `fileId` against `^[A-Za-z0-9_-]{1,64}$`. Invalid → 400.
  - Look up the row by `fileId`. Not found → 404 (idempotent: a re-delete after a successful delete returns 404, which the SPA treats as "already gone").
  - Compute the on-disk path: `${UPLOAD_DIR}/${fileId}${path.extname(fileName)}` (where `UPLOAD_DIR` is the existing `process.env.UPLOAD_DIR || './documents'`).
  - Delete all Qdrant points where `payload.filePath == <computed-on-disk-name>` using a filter-based bulk delete. Filter shape: `{must: [{key: 'filePath', match: {value: <on-disk-name>}}]}`.
  - Delete the file from disk (best-effort: log `warn` if missing, do not throw).
  - Delete the row from `documents`.
  - Return `200 {success: true, chunksDeleted: <number>, fileId: <id>}`. `chunksDeleted` is the count of Qdrant points removed (or 0 if the count can't be computed).
- **FR-5** The delete order MUST be: Qdrant delete → file unlink → SQLite delete. If Qdrant delete fails, return `500` without touching disk or SQLite (system stays consistent; user can retry). If file unlink fails (missing file), log `warn` and continue. If SQLite delete fails after the previous two succeed, return `500` — system is now in a state where Qdrant is clean but the row exists; the next DELETE attempt will succeed because the Qdrant delete is idempotent.
- **FR-6** Deleting a document MUST NOT affect any conversation history that previously cited its chunks. Past assistant messages retain their `sources` (which include `fileName`/`filePath` of the deleted doc). The SourceDrawer renders "file no longer available" for sources pointing to deleted files but does not crash.
- **FR-7** `GET /api/status` MUST add a `documents: number` field (the count of rows in `documents`). The existing fields (`chunks`, `ollamaAvailable`, `llmModel`, `llmContextSize`) are unchanged.
- **FR-8** The SPA MUST render a "Documents" section on `/upload`, below the upload queue. Each row: file-type chip, filename, chunk count, uploaded-at timestamp (formatted via the existing `fmtRelative` helper if present, else `Intl.RelativeTimeFormat`), delete button.
- **FR-9** Clicking the delete button MUST show an inline confirm (a second click within 5s on the same row confirms; otherwise the confirm state expires). On confirm, the row disappears optimistically and a DELETE is fired. On success, the row stays gone. On failure (network / 500), the row reappears with an inline error message in the row.
- **FR-10** The Documents list MUST reload after a successful upload (so newly-indexed docs appear immediately). This reuses the existing `GET /api/documents` poll or an explicit refresh on upload completion.
- **FR-11** The Documents list MUST re-fetch after a successful delete (chunk count on `/api/status` updates; the documents count on `/api/status` updates; the row stays gone).
- **FR-12** Deleting a document MUST NOT cause any other in-flight chat to fail. If a chat query mid-stream encounters a deleted chunk, the chat completes normally; the SourceDrawer for that source shows "file no longer available" if clicked.

### Agentic RAG

- **FR-13** `expand=auto` MUST be accepted on `POST /api/chat` and `POST /api/chat/stream`. **Default is `auto`** in Phase 03 — every chat message runs the agent loop unless the caller explicitly overrides with `expand=none`, `expand=siblings`, or `expand=sections`. If the LLM provider does not support `tools`, the server falls back to non-agentic behavior (FR-22) and emits a `warn` log; persisted `toolCalls` is `null` for that turn. The behavior change vs Phase 02 is documented in the README's "Breaking changes from Phase 02 → Phase 03" section.
- **FR-14** When `expand=auto`, the server MUST expose four tools to the LLM via the OpenAI-compatible `tools` parameter. Tool definitions are JSON-schema'd and stable; see `design.md` §Agent tool definitions.
  - `get_neighbor_chunks(filePath: string, chunkIndex: int, range: int = 2)` — fetch chunks ±range around `chunkIndex` in the same document.
  - `get_section_chunks(filePath: string, headingPath: string[])` — fetch all chunks in the same `headingPath` within the same document.
  - `get_chunk(chunkId: string)` — fetch a single chunk by ID.
  - `get_document(filePath: string)` — fetch document metadata (name, type, chunk count, uploaded_at).
- **FR-15** The agent loop MUST bound itself to `MAX_AGENT_ITERATIONS` (default `3`, env `MAX_AGENT_ITERATIONS`) iterations. Each iteration is one LLM call plus zero-or-more tool executions. After `MAX_AGENT_ITERATIONS` iterations without a final answer, the loop terminates with whatever text was accumulated (or a placeholder "I wasn't able to find a definitive answer." if empty).
- **FR-16** Each iteration MUST cap the **total** token count of tool-result text at `TOOL_RESULT_TOKEN_CAP` (default `10_000`, env `TOOL_RESULT_TOKEN_CAP`). The cap is applied incrementally: as each tool result is concatenated to the running total, once the total would exceed the cap, the remainder is truncated and a `truncated: true` flag is set on that tool result.
- **FR-17** Tool-result token counts MUST be measured by `gpt-tokenizer` (`cl100k_base`) — the same tokenizer the chunker uses. A small helper (`utils/text-token-budget.ts`) wraps encode/decode + truncate.
- **FR-18** The SSE stream MUST emit two new event types when the agent loop runs:
  - `event: tool_call\ndata: {"name":"...","arguments":{...},"iteration":N}\n\n` — emitted after the LLM produces a tool call, BEFORE the tool executes. `arguments` is the parsed JSON object.
  - `event: tool_result\ndata: {"name":"...","result":<...>,"truncated":bool,"iteration":N}\n\n` — emitted after the tool executes, with the result as a JSON value (string for chunk lists / document metadata). Truncation is reflected in the `truncated` flag.
- **FR-19** Existing SSE events (`meta`, `sources`, `token`, `done`, `title`, `error`) MUST keep their existing semantics. `event: sources` is emitted ONCE, before the first iteration, with the initial-search chunks. Additional sources retrieved via tools are surfaced via `tool_result` events (and aggregated into the persisted `sources` field).
- **FR-20** The `done` event MUST include an `iterations` field with the number of LLM calls made (1 to `MAX_AGENT_ITERATIONS`). The persisted assistant message MUST include a `toolCalls` field with `Array<{name, arguments, result, truncated, iteration}>` (nullable for non-agentic messages).
- **FR-21** When `expand=auto` and the LLM does NOT call any tools (returns a final answer on iteration 1), the SSE stream is identical to `expand=none` minus the extra `tool_*` events. The `toolCalls` column on the persisted message is `null` (or an empty array — see OD-3).
- **FR-22** When the LLM provider returns an error mid-agent-loop, the server MUST emit `event: error` and close the stream (same as Phase 02). The agent loop's accumulated partial state is discarded; the persisted assistant message is NOT written (Phase 02 behavior).
- **FR-23** When the client disconnects mid-agent-loop, the server MUST abort the in-flight OpenAI stream (Phase 02 behavior, FR-21). The loop checks `signal.aborted` between iterations and between tool executions and returns cleanly if set. No orphan LLM call.
- **FR-24** A new migration `004_tool_calls.sql` MUST add a `tool_calls` column to `messages` (TEXT, nullable, JSON-encoded). Existing messages have `tool_calls = NULL`. The migration is additive — no row rewrites.
- **FR-25** `ConversationStore.appendAssistantMessage` MUST accept an optional `toolCalls` parameter. When provided, it's JSON-encoded and stored in the new column. When omitted, the column is `NULL`.
- **FR-26** The SPA's SSE parser MUST handle `tool_call` and `tool_result` events. The `Bubble` component MUST render each as a small chip below the assistant message:
  - `tool_call` chip: tool name + a short arguments preview (truncated to ~30 chars). Click expands to show full arguments and the matching `tool_result` below it.
  - `tool_result` chip: tool name + a one-line summary ("3 chunks" / "12 chunks" / "metadata"). The expanded view shows the result body (truncated to ~500 chars in the chip; full body accessible via a "see full" toggle).
- **FR-27** The chat toolbar MUST add an expand-mode toggle with four options: `None`, `Siblings`, `Sections`, `Auto`. **Default `Auto`.** The current selection is shown as a chip in the toolbar; clicking the chip opens a small popover with the four options. The selection persists in `localStorage` (key `dockhoj.expandMode`) so reloads keep the user's preference. The first-time default (no `localStorage` entry) is `Auto`.
- **FR-28** When the expand mode is changed, subsequent chat sends use the new mode. There is no in-flight migration; an in-flight stream continues with its original mode.
- **FR-29** The Qdrant payload filter delete (`deleteByFilePath`) MUST use Qdrant's `client.delete(collectionName, { filter: { must: [{ key: 'filePath', match: { value } }] } })` — the same shape as `buildSearchFilter`. The primitive returns `{ deleted: number }` (from the response).
- **FR-30** The agent tools MUST be pure functions: `get_neighbor_chunks` and `get_section_chunks` wrap existing `services/qdrant.ts` primitives (`fetchByFilePathAndIndex`, `fetchByFilePathAndHeadingPath`) which are promoted to public exports. `get_chunk` calls `client.retrieve(collection, { ids: [chunkId] })`. `get_document` queries the new `documents` SQLite table by `filePath`. Each tool returns a JSON-serializable value or throws a structured error (`{tool: <name>, code: 'NOT_FOUND' | 'INVALID_ARG', message: string}`).

### Build, package, deploy

- **FR-31** No new dependencies are required. The OpenAI SDK already supports `tools`; the SQLite driver already supports `ALTER TABLE`; `gpt-tokenizer` is already in the chunker. Reuse what's in `package.json`.
- **FR-32** `MAX_AGENT_ITERATIONS` (default `3`) and `TOOL_RESULT_TOKEN_CAP` (default `10000`) MUST be readable from `process.env`. Documented in `README.md` env vars table.
- **FR-33** `Dockerfile` and `docker-compose.yml` need no changes — no new services, no new volumes, no new build steps.
- **FR-34** The SPA MUST build cleanly (`npm --prefix web run build`) with the new `tool_call` / `tool_result` event handlers. No new SPA dependencies expected.

### Tests

- **FR-35** Unit tests MUST cover:
  - `DocumentStore` CRUD against `:memory:` SQLite: insert on upload, list, delete, get-by-id, idempotent re-delete.
  - `deleteByFilePath` against a real Qdrant (in the integration test harness): inserts N chunks with the same `filePath`, deletes, asserts all N are gone.
  - Each agent tool (`get_neighbor_chunks`, `get_section_chunks`, `get_chunk`, `get_document`) with a stubbed Qdrant + stubbed SQLite: success path, not-found path, invalid-arg path.
  - `agent-loop.ts` with a stubbed OpenAI client returning canned responses: loop terminates after N iterations, loop terminates on final-answer, loop honors `signal.aborted`, tool-result token cap is applied.
  - `streamChatCompletionWithTools` against a stubbed OpenAI stream that emits text deltas + a final tool_calls array: yields `{text, toolCalls}` correctly.
- **FR-36** Route tests (via `fastify.inject`) MUST cover:
  - `GET /api/documents` returns the rows in uploaded-at-DESC order; empty list returns `[]`.
  - `DELETE /api/documents/:fileId` happy path: row + chunks + file all removed.
  - `DELETE /api/documents/:fileId` 404 for unknown id; 400 for invalid id; 500 on Qdrant failure (mocked).
  - `POST /api/chat/stream` with `expand=auto` emits the right SSE event sequence (including `tool_call`/`tool_result` events) when the OpenAI stub returns a tool call.
  - `POST /api/chat/stream` with `expand=auto` falls back to non-agentic behavior when the LLM provider doesn't support `tools`.
- **FR-37** Component tests (`@testing-library/preact`) MUST cover:
  - `Bubble.tsx` renders tool-call chips with arguments preview; click expands.
  - `Bubble.tsx` renders tool-result chips with summary; click expands.
  - Toolbar expand-mode toggle: click opens popover; click option updates selection; localStorage is written.
- **FR-38** E2E tests (`./restart.sh` + `curl`) MUST cover:
  - Upload a sample → `GET /api/documents` shows it → `DELETE /api/documents/<id>` → row gone, file gone, chunks gone (verify via `/api/search?q=...` not returning the deleted file's content).
  - Send a chat with `expand=auto` against a stubbed-via-env LLM, assert the SSE stream emits at least one `tool_call`/`tool_result` event pair (see OD-4 for whether the e2e uses a real LLM or a stub).

## Non-functional requirements

- **NFR-1** Document deletion MUST complete in < 1s p95 for documents with ≤ 1,000 chunks. The Qdrant filter delete is one round-trip; SQLite delete is one statement; file unlink is local.
- **NFR-2** The agent loop's total wall-clock time MUST be bounded. With `MAX_AGENT_ITERATIONS=3` and `TOOL_RESULT_TOKEN_CAP=10000`, the upper bound is `3 * (max(LLM_latency, sum(tool_latencies)) + 10K_token_prompt_assembly)`. We don't enforce this with a timeout in this phase — the LLM provider's own timeout applies. (Future: a `MAX_AGENT_WALL_MS` env.)
- **NFR-3** Test coverage on new code (`src/services/agent-tools.ts`, `src/services/agent-loop.ts`, `src/services/document-store.ts`, `src/routes/api-documents.ts`, `web/src/services/documents.ts`, `web/src/components/DocumentsList.tsx`, `web/src/components/ToolCallChip.tsx`, `web/src/components/ToolResultChip.tsx`) MUST be ≥ 80% lines each. Project overall ≥ 80%.
- **NFR-4** All new env vars default to safe values. `MAX_AGENT_ITERATIONS=3` (small, bounded); `TOOL_RESULT_TOKEN_CAP=10000` (small enough to fit in any modern LLM context).
- **NFR-5** No `console.log` / debug prints in production code. Pino at `info` / `warn` / `error` levels only.
- **NFR-6** No commented-out code committed.
- **NFR-7** Bundle size target: SPA bundle stays < 350 KB gzipped (was 300 KB in Phase 02; +50 KB accommodates the new components). Enforced in CI via a build-step size assertion.
- **NFR-8** The new `documents` table MUST use the same SQLite singleton, WAL pragma, and FK pragma as the existing tables (see `src/db/index.ts`). No new connection management.
- **NFR-9** `deleteByFilePath` MUST be safe to call on a collection that doesn't contain any matching points. Qdrant returns `{deleted: 0}`; the SQLite delete still proceeds; no error.
- **NFR-10** The agent loop MUST use `p-limit`-style bounded concurrency when executing multiple tool calls in one iteration. Default concurrency: 4. This prevents one slow Qdrant call from blocking the whole iteration.

## Out of scope (this phase)

- **Bulk delete** (`DELETE /api/documents?ids=...`). One-at-a-time is enough for the realistic scale.
- **Soft delete / trash / undo.** Delete is destructive. The row is gone.
- **Document re-indexing** ("refresh" button). Future phase.
- **Cross-encoder re-ranking**, hierarchical chunks, parent-child storage.
- **True interleaved streaming** (per-token tool-call streaming). The OpenAI SDK emits `tool_calls` at the end of each iteration's stream; we accept that model.
- **Pagination** on `/api/documents` and `/api/chat/stream`. Unbounded for now.
- **Per-tool authorization / sandboxing.** All tools are server-side; no user-supplied code paths.
- **Document re-upload collision detection.** Uploads always mint a fresh UUID.
- **Document rename** (changing `fileName` after upload). The user can upload with a different filename.
- **Source filtering by uploaded-date range, by chunk count, etc.** on `/api/search`. Existing filter set is unchanged.
- **Streaming agent-loop on `POST /api/chat`** (the non-streaming endpoint). The non-streaming path uses `expand=auto` with a blocking agent loop; same final result shape but without SSE. The non-streaming path is a future addition if needed (probably not — the SPA only streams).
- **A separate "Documents" page** (`/documents`). The list lives on `/upload`.

## Constraints & assumptions

- **Single user, single tenant.** No auth, no per-user isolation in SQLite.
- **No new runtime services.** SQLite (existing) and Qdrant (existing) are sufficient.
- **OpenAI-compatible API.** Tool use via `tools: [{type: 'function', function: {...}}]`. Supported by OpenAI, MiniMax, and most OpenAI-compatible gateways. **Caveat:** some gateways don't support `tools` — covered by FR-22 / U11 fallback.
- **Streaming token + tool-call.** The OpenAI SDK's `stream: true` mode emits `delta.content` (text) incrementally and `delta.tool_calls` (partial tool calls) incrementally. We accumulate `tool_calls` across chunks until the stream ends, then emit one `tool_call` event per call.
- **Token counting.** `gpt-tokenizer` (`cl100k_base`) is already a dependency (used by the chunker). Reuse `countTokens` from `utils/chunk-tokenizer.ts`; add a `truncateToTokenBudget(text, budget)` helper next to it.
- **Existing `expand=none|siblings|sections` semantics.** Preserved unchanged. New `expand=auto` is additive.
- **Document `fileId` is the public API identifier.** Distinct from `fileName` (which can repeat). The SPA passes `fileId` to the DELETE endpoint.
- **Document delete is destructive.** No undo. No trash. The user confirms in the UI; on confirm, the row is gone.
- **Tool-result truncation is lossy.** When a tool result is truncated to fit the token cap, the LLM sees a partial result. This is acceptable for retrieval tools (the LLM can ask for a different chunk / section). The `truncated: true` flag is surfaced in the SSE event for transparency.
- **Source persistence unchanged.** Sources from initial search AND from tool results are accumulated into the assistant message's `sources` field. Click-handling in the SourceDrawer (Phase 02) renders the chunk text even if the file is later deleted (a stale-cache indicator — see OD-5).

## Acceptance criteria

The phase is done when **all** of the following are true:

1. `npm run build` (server) and `npm --prefix web run build` (client) both succeed clean.
2. `npm test` passes with project line coverage ≥ 80% and the new code's coverage targets met.
3. A fresh `docker compose up` boots the app; `/upload` shows the "Documents" section below the queue (empty initially).
4. Upload a sample markdown → row appears in the queue → row transitions to "ready" → a moment later, the doc appears in the Documents section.
5. Click delete on the doc, confirm → row disappears optimistically → `GET /api/documents` no longer lists it → `/api/search?q=...` for a phrase in the deleted doc returns nothing → restart the container, all three are still true.
6. `/chat` toolbar shows the expand-mode chip (default `Auto` per FR-27). Click to open popover. Select `None`. Send "What's in chapter 2 of notes.md?" — see no tool chips; behavior matches Phase 02. (Re-select `Auto` to restore tool chips.)
7. With `Auto` selected, toggle to `None` — subsequent chat messages show no tool chips and behave identically to Phase 02.
8. `curl http://host/api/documents` returns `[{...}]` ordered by `uploaded_at DESC`.
9. `curl http://host/api/status` includes the new `documents` field.
10. `curl http://host/api/documents/<bogus>` returns 404 JSON.
11. `curl -X POST http://host/api/chat/stream -d '{"q":"hello","expand":"auto"}'` returns a valid SSE stream that includes `event: meta, sources, done` (tool events only if the LLM calls them).
12. `MAX_AGENT_ITERATIONS=1` env override: with the env set, the loop never iterates more than once.
13. `TOOL_RESULT_TOKEN_CAP=100` env override: with the env set, the per-iteration tool-result text is capped at 100 tokens; the SSE `tool_result` event has `truncated: true`.
14. Reviewer (the user) has signed off on `design.md` and `TASKS.md`.

## Open questions (need user input before / during implementation)

- **OQ-1** — ~~Default expand mode: keep `none` as default (no behavior change for existing users) or switch to `auto`?~~ **RESOLVED: switch to `auto` as default.** The user picked the more aggressive option. Every chat runs the agent loop unless the user explicitly overrides via the toolbar. Documented as a Phase 02 → Phase 03 behavior change in the README.
- **OQ-2** — **Document deletion UX:** inline confirm (a second click within 5s on the same row) vs a modal confirm (block the UI until dismissed) vs a "trash" with undo (5s soft-delete window) vs a destructive single-click. **Recommendation: inline confirm (second click within 5s).** Simpler than modal, no extra UI surface, recoverable within 5s. The user can always re-upload if they delete by mistake (single-user, no other consumers).
- **OQ-3** — ~~Where the Documents list lives: on `/upload` (below the queue) vs a new `/documents` page vs both?~~ **RESOLVED: on `/upload` below the queue.** Matches the existing topbar nav (only `Chat` / `Upload`); the upload page is the natural "manage your files" surface; no new topbar nav link.
- **OQ-4** — ~~E2E coverage for agentic mode: real LLM vs stubbed LLM vs hybrid?~~ **RESOLVED: stubbed LLM via env override (`LLM_BASE_URL` to a local mock server).** Fast, deterministic, exercises the real OpenAI SDK + the real agent loop. The unit tests cover the loop logic in isolation. The local mock server is implemented in `tests/e2e/_helpers/mock-llm.ts` and serves canned responses for `expand=auto` test scenarios (returns `delta.content` deltas + a `tool_calls` array when prompted).
- **OQ-5** — **Stale sources in SourceDrawer:** when a source chip in an old assistant message points to a deleted file, what does the drawer show? Three options: (a) silently show the cached chunk text (the message is historical — the source was real when the answer was generated), (b) show "file no longer available", (c) show the cached text with a "this file was deleted on <date>" footer. **Recommendation: (c).** The user can still see what the LLM saw; the deletion is transparent.
- **OQ-6** — **Tool result format:** the SSE `event: tool_result` `result` field is a JSON value. For chunk-retrieval tools, should it be `[{chunk text}]` (matches what the LLM sees) or `[{fileName, chunkIndex, pageNumber, text}]` (richer, what the SPA renders)? **Recommendation: rich.** The LLM doesn't care about the structure; it just reads the text. The SPA can use the rich form to render the chip preview.
- **OQ-7** — ~~What `expand=auto` does on first iteration: pre-fetch top-K + give tools vs start empty and let the LLM call tools?~~ **RESOLVED: pre-fetch top-K AND give tools.** The LLM gets a useful starting context (cheap retrieval is already done) and can drill in with tools if needed. This matches the Phase 02 deferred note ("Default `expand=auto` (LLM decides); preserve `expand=sections` and `expand=none` as overrides for deterministic / cheap modes").
- **OQ-8** — **Tool-result cap application order:** when one iteration has 3 tool calls and the cap is 10K tokens, do we (a) truncate each result individually to 10K/3 ≈ 3333 tokens, (b) concatenate first then truncate the total to 10K, or (c) truncate only the last one once the running total would exceed 10K? **Recommendation: (c).** Tool calls earlier in the iteration get full results; later calls may be truncated. This preserves the order of execution and is what `gpt-tokenizer` truncation naturally supports.