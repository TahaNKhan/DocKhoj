# Tasks — Phase 03

Source of truth for in-flight work. Tasks are ordered by execution sequence. Update status as work progresses.

**Phase:** Document Deletion and Agentic RAG
**Spec:** [`README.md`](./README.md), [`requirements.md`](./requirements.md), [`design.md`](./design.md)

---

## p3-T01 — `documents` table + `DocumentStore` + upload wiring + status count

- **Description:** Add migration `src/db/migrations/003_documents.sql` (the `documents` table + `idx_documents_uploaded_at`). Create `src/services/document-store.ts` with the `DocumentStore` class (`insert`, `list`, `get`, `delete`). Wire it into `processUpload` in `src/routes/upload.ts` so a `documents` row is inserted AFTER successful Qdrant upsert (uses the same `db` singleton the routes already have). Extend `src/routes/api-status.ts` to add a `documents: number` field (count of rows in the table).
- **Maps to FR:** FR-1, FR-2, FR-7
- **Maps to design:** §Data model (003), §Module layout, §Upload integration
- **Acceptance:**
  - Fresh container boot: `_migrations` records `003`; second boot is a no-op.
  - Unit test on `:memory:` DB: `insert` → `list` returns the row in `uploaded_at DESC`; `get` returns the row by fileId; `delete` removes it; `delete` on missing returns `false`.
  - E2E: upload a sample → `GET /api/status` shows `documents: 1`; upload another → `documents: 2`.
  - E2E: parse-failure upload (corrupt file) → `documents` count unchanged.
- **Depends on:** —
- **Estimate:** S
- **Status:** done (commits `61b640c`, `b97ef31`, `b254038`)

---

## p3-T02 — Qdrant `deleteByFilePath` + `/api/documents` routes

- **Description:** Add `deleteByFilePath(filePath)` to `src/services/qdrant.ts` (filter-based bulk delete, returns the deleted count). Promote `fetchByFilePathAndIndex` and `fetchByFilePathAndHeadingPath` from private to public. Create `src/routes/api-documents.ts` with `GET /api/documents` (list) and `DELETE /api/documents/:fileId` (delete: Qdrant → file unlink → SQLite). Register the route in `src/index.ts`.
- **Maps to FR:** FR-3, FR-4, FR-5, FR-6, FR-29
- **Maps to design:** §Qdrant filter delete, §Document delete (route handler), §API surface > HTTP
- **Acceptance:**
  - `deleteByFilePath` integration test (real Qdrant): insert 10 chunks with the same `filePath`, delete, assert all 10 are gone.
  - Route test (fastify.inject): `GET /api/documents` returns rows in `uploaded_at DESC` order; `[]` when empty.
  - Route test: `DELETE /api/documents/:fileId` happy path → 200 + `{success, chunksDeleted, fileId}` + row gone + chunks gone + file gone.
  - Route test: `DELETE /api/documents/:fileId` with unknown fileId → 404.
  - Route test: `DELETE /api/documents/:fileId` with invalid fileId (regex fail) → 400.
  - Route test: `DELETE /api/documents/:fileId` with mocked Qdrant failure → 500 + disk + SQLite untouched.
  - Route test: re-DELETE after successful DELETE → 404 (idempotent from SPA perspective).
- **Depends on:** p3-T01
- **Estimate:** M
- **Status:** done (commits `b97ef31`, `b254038`, `a6f0c63`)

---

## p3-T03 — SPA: document service + `DocumentsList` + integrate into `/upload`

- **Description:** Add `web/src/services/documents.ts` (`listDocuments`, `deleteDocument`). Add `web/src/types.d.ts` `Document` type. Create `web/src/components/DocumentsList.tsx` with inline-confirm delete UX (second click within 5s; 500 → row reappears with inline error). Extend `web/src/routes/Upload.tsx` to render the DocumentsList below the queue; reload after a successful upload completes; reload after a successful delete completes.
- **Maps to FR:** FR-8, FR-9, FR-10, FR-11, FR-12
- **Maps to design:** §Documents SPA service, §DocumentsList component, §Module layout
- **Acceptance:**
  - Component test (`@testing-library/preact`): render with seed documents → rows visible; click delete → confirm state; click again within 5s → `onDelete` fires; wait 6s → confirm state expires.
  - Component test: `onDelete` rejects → error state renders; click dismiss → error clears.
  - E2E (Docker): upload 2 docs → both appear in list; delete one → list updates + `/api/documents` reflects + `/api/status.documents` updates.
- **Depends on:** p3-T02
- **Estimate:** M
- **Status:** done (commit `a6f0c63`)

---

## p3-T04 — Migration `004_tool_calls.sql` + `ConversationStore.appendAssistantMessage(...toolCalls)`

- **Description:** Add migration `src/db/migrations/004_tool_calls.sql` (`ALTER TABLE messages ADD COLUMN tool_calls TEXT`). Extend `src/services/conversations.ts` `Message` type with `toolCalls?: ToolCallRecord[]`. Extend `ConversationStore.appendAssistantMessage` to accept an optional `toolCalls` parameter; JSON-encode and persist it. Extend `readMessage` and `listMessages` to decode and return it.
- **Maps to FR:** FR-24, FR-25
- **Maps to design:** §Data model (004), §TypeScript types
- **Acceptance:**
  - Fresh boot: `_migrations` records `004`; existing rows have `tool_calls = NULL`.
  - Unit test (`:memory:` DB): append assistant message with `toolCalls: [{name, arguments, ...}]` → `listMessages` returns it with the structured `toolCalls` field intact.
  - Unit test: append assistant message WITHOUT `toolCalls` → `toolCalls` is `undefined` on the returned message.
- **Depends on:** —
- **Estimate:** S
- **Status:** done (commit `4bef46e`)

---

## p3-T05 — `services/agent-tools.ts` (the four tool implementations)

- **Description:** Create `src/services/agent-tools.ts` with `AGENT_TOOLS` (the four OpenAI tool definitions as `ChatCompletionTool[]`) and `executeAgentTool(name, args)` (dispatches to the appropriate primitive, returns `AgentToolResult`). Each tool wraps an existing service: `get_neighbor_chunks` → `fetchByFilePathAndIndex`, `get_section_chunks` → `fetchByFilePathAndHeadingPath`, `get_chunk` → `qdrantClient.retrieve`, `get_document` → `DocumentStore.get(fileId)` (where `fileId` is reconstructed by stripping the extension from `filePath`).
- **Maps to FR:** FR-14, FR-30
- **Maps to design:** §Agent tool definitions, §Agent tool execution
- **Acceptance:**
  - Unit tests: each tool's success path with a stubbed Qdrant + stubbed SQLite.
  - Unit tests: each tool's `NOT_FOUND` path (Qdrant returns empty, SQLite returns null).
  - Unit tests: each tool's `INVALID_ARG` path (missing/wrong-type args).
  - Unit test: `get_neighbor_chunks` with `range > 5` clamps to 5.
- **Depends on:** p3-T02, p3-T04 (DocumentStore exists)
- **Estimate:** M
- **Status:** done (commit `bdc9fce`)

---

## p3-T06 — `streamChatCompletionWithTools` in `openai-api-wrapper.ts`

- **Description:** Extend `src/services/openai-api-wrapper.ts` with `streamChatCompletionWithTools(messages, tools, signal)` that calls `openai.chat.completions.create({ ..., tools, stream: true })` and yields `{text, toolCalls}` per chunk. The `toolCalls` array is accumulated across chunks (the OpenAI SDK emits partial `tool_calls` per chunk with `index`, incremental `id` / `function.name` / `function.arguments`). The final yield after stream-end is the completed tool_calls array.
- **Maps to FR:** FR-18, FR-19
- **Maps to design:** §Stream-with-tools wrapper
- **Acceptance:**
  - Unit test: stubbed OpenAI stream that emits 3 text deltas + a final tool_calls array → generator yields 3 `{text, toolCalls: []}` chunks + 1 `{text: '', toolCalls: [...]}` final chunk.
  - Unit test: stubbed OpenAI stream that throws on `tools` not supported → generator throws (caller's responsibility to catch).
  - Unit test: `signal.aborted` between chunks → generator returns cleanly.
- **Depends on:** —
- **Estimate:** S
- **Status:** done (commit `01af75e`)

---

## p3-T07 — `services/agent-loop.ts` (bounded loop, token cap, tool execution)

- **Description:** Create `src/services/agent-loop.ts` with `streamAgentChat(params, signal)` — the bounded agent loop generator. Initial retrieval (embed + search) → yield `sources` → build messages with system prompt + history + initial context → loop up to `MAX_AGENT_ITERATIONS` times: call `streamChatCompletionWithTools`, accumulate text + tool_calls, yield `token` events, if no tool_calls → yield `done` and return, else append assistant message + execute each tool call (sequential, with per-iteration token cap via `truncateToTokenBudget`) + yield `tool_call`/`tool_result` events + append tool messages. Track all chunks retrieved via tools as additional sources for citation. Add `src/utils/text-token-budget.ts` with `countTokens` and `truncateToTokenBudget`.
- **Maps to FR:** FR-15, FR-16, FR-17, FR-18, FR-19, FR-20, FR-21, FR-22, FR-23
- **Maps to design:** §Agent loop, §Token budget helper
- **Acceptance:**
  - Unit test (stubbed LLM returning final answer on iter 1): yields `meta, sources, token*, done` with `iterations: 1`.
  - Unit test (stubbed LLM returning tool_call on iter 1, then final answer on iter 2): yields the full sequence including `tool_call`, `tool_result` events.
  - Unit test (stubbed LLM returning tool_calls for all 3 iterations, no final answer): yields `done` with `iterations: 3`; cap is honored.
  - Unit test (stubbed tool returning a 20K-token result, cap = 10K): yields `tool_result` with `truncated: true`.
  - Unit test (signal aborted between iterations): generator returns cleanly; no more yields.
  - Unit test (OpenAI stream throws): yields `event: error`; generator returns.
- **Depends on:** p3-T05, p3-T06
- **Estimate:** L
- **Status:** done (commit `5b5a102`)

---

## p3-T08 — `routes/chat-stream.ts` extended to dispatch to agentic path; persist `toolCalls`

- **Description:** Extend `src/routes/chat-stream.ts` to dispatch to `streamAgentChat` when `expand=auto`, otherwise to `streamChatCompletion` (existing). Extend `StreamEvent` to include `tool_call` and `tool_result` variants. Add `event: tool_call` and `event: tool_result` SSE write paths. Extend the `done` event payload with `iterations` (1 for non-agentic, `iterations` from the agent loop otherwise). Persist `toolCalls` on the assistant message via the extended `ConversationStore.appendAssistantMessage` when `expand=auto` AND there were tool calls.
- **Maps to FR:** FR-13, FR-18, FR-19, FR-20, FR-21, FR-22, FR-23, FR-25
- **Maps to design:** §Stream-with-tools SSE dispatch
- **Acceptance:**
  - Route test (fastify.inject, stubbed OpenAI returning a tool call): full SSE event sequence includes `tool_call`, `tool_result`.
  - Route test (stubbed OpenAI returning final answer on iter 1): no `tool_call`/`tool_result` events; `done` carries `iterations: 1`.
  - Route test (stubbed OpenAI tool not supported → SDK throws): handler falls back to `expand=none` path; no `tool_call`/`tool_result` events; logged at `warn`.
  - Route test (client disconnect mid-agent-loop): server aborts; partial message not persisted.
  - E2E (stubbed LLM via `LLM_BASE_URL` env override): real SSE stream includes `tool_call`/`tool_result` events; persisted message has `tool_calls` column populated.
- **Depends on:** p3-T04, p3-T07
- **Estimate:** M
- **Status:** done (commit `5b5a102`)

---

## p3-T09 — Client SSE: `tool_call`/`tool_result` handling + bubble chips

- **Description:** Extend `web/src/services/stream.ts` to parse the new SSE event types (`tool_call`, `tool_result`). Add `web/src/types.d.ts` `ToolCallRecord`, `ToolResultRecord` types. Create `web/src/components/ToolCallChip.tsx` (expand/collapse, args preview, iteration badge) and `web/src/components/ToolResultChip.tsx` (expand/collapse, summary, truncated flag). Extend `web/src/components/Bubble.tsx` to render the chips below the assistant message when `toolCalls` is present.
- **Maps to FR:** FR-26
- **Maps to design:** §Tool-call / tool-result chips, §Bubble wiring
- **Acceptance:**
  - Component test (`@testing-library/preact`): `Bubble` with `toolCalls: [...]` renders chips; click expands.
  - Component test: `ToolCallChip` shows args preview; click → full args.
  - Component test: `ToolResultChip` shows summary (e.g. "3 chunks"); `truncated: true` shows truncated badge; click → full result (with truncation banner if truncated).
  - Unit test for `stream.ts` parser: hand-crafted SSE chunk with `event: tool_call\ndata: {...}\n\n` is parsed correctly; new event types are dispatched.
- **Depends on:** p3-T08
- **Estimate:** M
- **Status:** done (commit `4169f49`)

---

## p3-T10 — Chat toolbar: expand-mode toggle

- **Description:** Extend `web/src/routes/Chat.tsx` toolbar with an expand-mode toggle (`None` / `Siblings` / `Sections` / `Auto`). Default is `Auto` (per OQ-1 user decision). Persist the selection in `localStorage` (key `dockhoj.expandMode`); read on mount. Pass the selected mode as `expand` in the chat send body. Existing chat continue with their original mode (no in-flight migration). Server-side `parseExpandMode` default changes from `'none'` to `'auto'` (in `routes/chat-stream.ts` and `routes/chat.ts`).
- **Maps to FR:** FR-13, FR-27, FR-28
- **Maps to design:** §Expand-mode toggle, OD-1
- **Acceptance:**
  - Component test: toolbar renders the toggle; default is `Auto` (when no `localStorage` entry); click → popover opens; click `None` → selection updates + `localStorage` written; popover closes.
  - Component test: refresh the page (mock `localStorage.getItem` returning `'auto'`) → toolbar shows `Auto` on mount.
  - Component test: refresh the page (mock `localStorage.getItem` returning `'none'`) → toolbar shows `None` on mount.
  - E2E: select `Auto`, send a chat → request body includes `"expand":"auto"`.
  - Route test (fastify.inject): `POST /api/chat/stream` with no `expand` field → handler dispatches to `streamAgentChat`.
  - Route test: `POST /api/chat/stream` with `expand=none` → handler dispatches to `streamChatCompletion` (existing non-agentic path).
  - Route test: `POST /api/chat/stream` with `expand=siblings` → handler dispatches to `streamChatCompletion` with siblings mode.
- **Depends on:** —
- **Estimate:** S
- **Status:** done (commit `6cb13a1` + this commit)

---

## p3-T11 — Coverage thresholds + README updates + final integration test pass

- **Description:** Update `vitest.config.ts` coverage thresholds to include the new code paths at ≥ 80% lines each (new files: `document-store.ts`, `agent-tools.ts`, `agent-loop.ts`, `text-token-budget.ts`, `api-documents.ts`; new SPA components). Update `README.md` with: new env vars (`MAX_AGENT_ITERATIONS`, `TOOL_RESULT_TOKEN_CAP`), new endpoints (`/api/documents`, `/api/documents/:fileId`), new SSE events (`tool_call`, `tool_result`), updated `/api/status` shape (adds `documents`), expand-mode docs (None/Siblings/Sections/Auto). Update the "Breaking changes from Phase 02 → Phase 03" section (none — Phase 03 is additive). Run the full `./restart.sh` + `curl` smoke test to validate the new surfaces end-to-end.
- **Maps to FR:** FR-32, FR-34, NFR-3, NFR-7
- **Maps to design:** §Deployment / runtime > New env vars, §Module layout (README)
- **Acceptance:**
  - `npm test` passes; coverage thresholds enforced.
  - `npm run build` (server + web) succeeds; SPA bundle < 350 KB gzipped.
  - `./restart.sh` boots; `curl /api/status` includes `documents`.
  - `curl /api/documents` returns `[]` on fresh boot; populates after an upload.
  - `curl -X POST /api/chat/stream -d '{"q":"hello","expand":"auto"}'` returns a valid SSE stream with the new event envelope.
  - README updated; user signs off.
- **Depends on:** p3-T01, p3-T02, p3-T03, p3-T04, p3-T05, p3-T06, p3-T07, p3-T08, p3-T09, p3-T10
- **Estimate:** M
- **Status:** done (this commit)

---

## Notes / blockers

_(none yet)_