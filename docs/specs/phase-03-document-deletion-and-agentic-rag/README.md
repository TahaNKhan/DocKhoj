# Phase 03 — Document Deletion and Agentic RAG

**Status:** planning
**Started:** —
**Done:** —

## Isolation
- **Branch:** `main` (medium-large feature — multi-day, spans server + SPA + persistence; spec folder only, no dedicated worktree)
- **Worktree:** n/a

## Pointers
- **Tasks:** T44 … T54 in [`TASKS.md`](./TASKS.md) (this folder)
- **Spec:** [`requirements.md`](./requirements.md), [`design.md`](./design.md)
- **Related specs:** Phase 01 (`../phase-01-smart-chunker-and-cleanup/`), Phase 02 (`../phase-02-frontend-streaming-and-persistence/`)

## Why isolated (or not)
Two distinct features that each touch multiple layers:

- **Document deletion** adds a new persisted entity (`documents` SQLite table) alongside the Qdrant vector store, two new HTTP endpoints, the Qdrant filter-delete primitive, a new SPA section, and confirms a previously-deferred requirement (the document-delete endpoint was deferred from Phase 01).
- **Agentic RAG** introduces an LLM tool-use loop, an OpenAI streaming variant that carries tool_calls, two new SSE event types, tool-result token capping, persistence of tool calls on assistant messages, and a chat-toolbar mode picker.

Together they touch the server (`src/db/`, `src/services/`, `src/routes/`), the SPA (`web/src/`), the build pipeline (new dependencies if any — none expected), and the public surface (`README.md`, env vars). Each can be reviewed independently; the tasks in `TASKS.md` are ordered so the document-deletion track lands before the agentic-RAG track and each commit is testable in isolation.

No dedicated worktree: review is sequential and the spec is the contract. Spans 13 commits at most.

## Scope summary
- **Document deletion:**
  - New `documents` SQLite table (migration `003_documents.sql`) tracking each uploaded file's `fileId`, `fileName`, `fileType`, `bytes`, `uploadedAt`, `chunkCount`.
  - New endpoints: `GET /api/documents`, `DELETE /api/documents/:fileId`. The DELETE removes Qdrant points (filter on `filePath`), the on-disk file, and the SQLite row — in that order, with idempotent partial failures.
  - New Qdrant primitive: `deleteByFilePath(filePath)` (filter-based bulk delete).
  - New SPA service (`services/documents.ts`), new `DocumentsList` component, integrated into the `/upload` page below the upload queue.
  - `GET /api/status` adds a `documents: number` field.
- **Agentic RAG:**
  - New `expand=auto` mode (opt-in; default stays `none`). When set, the LLM is given four retrieval tools (`get_neighbor_chunks`, `get_section_chunks`, `get_chunk`, `get_document`) and may call them in a bounded loop.
  - Loop bounds: `MAX_AGENT_ITERATIONS` (default 3) iterations, `TOOL_RESULT_TOKEN_CAP` (default 10_000 tokens) per iteration. Both env-configurable.
  - Two new SSE events: `event: tool_call`, `event: tool_result`. Both stream live, interleaved with `event: token`.
  - New migration `004_tool_calls.sql` adds a `tool_calls` column on `messages` (nullable JSON). `ConversationStore.appendAssistantMessage` accepts an optional `toolCalls: ToolCall[]`.
  - `services/agent-tools.ts` — the four tool implementations, each a pure function over `services/qdrant.ts` + the `documents` table.
  - `services/agent-loop.ts` — the bounded agent loop generator; emits SSE events, accumulates sources across iterations, applies the per-iteration token cap.
  - `openai-api-wrapper.ts` extended with `streamChatCompletionWithTools(...)` that yields `{ text, toolCalls }` from the OpenAI streaming API with `tools` exposed.
  - Client SSE parser handles the two new event types. `Bubble.tsx` renders tool call chips below the message; chip click expands to show the tool's arguments and result.
  - Chat toolbar gets an expand-mode toggle (`None / Siblings / Sections / Auto`); default `None`.
- **Backward compatibility:**
  - All Phase 02 endpoints keep their existing shape.
  - `expand=none | siblings | sections` keep their existing behavior; only `expand=auto` adds the agent loop.
  - Default `expand` stays `none` so existing scripts and the Phase 02 UX don't change unless the user opts in.
  - Document deletion is purely additive — no existing behavior changes. Existing `chunkCount` on `/api/status` is unchanged; `documents` is added alongside it.
- **No new infrastructure services.** All state lives in SQLite (already running) and Qdrant (already running).

## Out of scope (this phase)
- Multi-user / authn / authz. Single-tenant, single-user self-hosted (unchanged from Phase 02).
- Bulk delete (delete many docs in one request). One-at-a-time DELETE is enough.
- Soft delete / trash / undo. Delete is destructive and final.
- Re-indexing / re-chunking of an existing document. (Future phase: a "refresh" button.)
- Re-ranking (cross-encoder), hierarchical chunks, parent-child storage.
- True streaming-tool-call state machine where the model emits text-and-tool-calls interleaved per token. The OpenAI SDK streams tool_calls at the end of each iteration's stream — we accept that model and emit `event: token` for all text and `event: tool_call` once tool_calls are fully assembled at the end of each iteration. True interleaved streaming of tool calls is a future optimization.
- Pagination on `/api/documents` and `/api/chat/stream`. Unbounded for now (single-user; few hundred docs is the realistic ceiling).
- Per-tool authorization / sandboxing. All tools are server-side, no user-supplied code paths.
- Document re-upload with collision detection (refuse re-upload of a file with the same `fileId`). Uploads always mint a fresh UUID.

## Decisions deferred to review
See `requirements.md` → "Open questions" and `design.md` → "Open decisions". Please flag any you want changed before implementation starts.