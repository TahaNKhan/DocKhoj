# Requirements — Phase 02

## Purpose

Modernize the DocKhoj frontend, turn one-shot chat into a persistent, streaming conversation surface, and lock in a clean routing convention so the codebase doesn't drift again.

After this phase:

1. The user has a real, multi-page UI that matches the exported design (`mockups/dockhoj-chat-v2.html` and `mockups/dockhoj-upload-v2.html`) instead of a single-page card stack.
2. Conversations survive container restarts; sessions are listed, switched, and named from the sidebar.
3. Chat tokens stream to the browser as they're generated — no more "thinking…" hang-then-dump.
4. The build step is reproducible and the Docker image keeps the production bundle small.
5. The routing convention is uniform: every API under `/api/*`, every page under `/{page}`. The single Fastify process serves both.
6. A single server executable (one Node process) runs the entire app: SPA static + `/api/*` + SPA fallback.

## Users / actors

- **End user** — uses DocKhoj daily. Cares about a polished chat experience, fast feedback during generation, and the ability to return to past conversations.
- **Operator** — runs DocKhoj in Docker. Cares about: build step lands cleanly in the existing image, SQLite DB lives on a persistent volume, no new infra services, `Dockerfile` `HEALTHCHECK` still works after the path move.
- **Future agent / contributor** — picks up the code after us. Cares about: shared types between client/server, design tokens preserved as code (not buried in HTML), test coverage on the new persistence and streaming layers.

## Use cases

| # | Flow | Acceptance signal |
|---|---|---|
| U1 | Open the app for the first time after Phase 02 lands. | `/chat` is the landing page; sidebar shows one empty session titled "New chat" or auto-titled from the first message. |
| U2 | Type "What did I read about habit loops?" and hit Enter. | First token appears in the AI bubble within ~300 ms of the server's first chunk (no "thinking…" delay before streaming starts). |
| U3 | Send a follow-up "Pull the cue half — what did I actually write?". | AI bubble builds on the prior turn; the session history (user + assistant turns) is persisted in SQLite and survives a container restart. |
| U4 | Click a different session in the sidebar mid-conversation. | The current session's in-flight stream (if any) aborts; the new session's full history renders. |
| U5 | Refresh the browser. | The current session ID is restored from URL hash (or `localStorage`); the chat history reloads from `GET /api/sessions/:id/messages`. |
| U6 | Upload a 2 MB PDF on `/upload`. | The file appears in the queue with `queued → embedding → ready` status transitions; progress bar animates; the existing `POST /api/upload` endpoint returns `{success, chunksIndexed}` once done. |
| U7 | Drop 10 files at once on the dropzone. | All 10 appear in the queue; bounded parallel upload (≤4) executes; per-file status is independent; failures don't block other files. |
| U8 | Container restart while a session has 12 turns of history. | After restart, the session is in the sidebar with all 12 turns, last-message timestamp preserved. |
| U9 | Click a source chip on a streaming response. | An inline drawer (or popover) opens showing the full chunk text with page/heading metadata and a link to `/api/download/<file>`. |
| U10 | Close the tab while a stream is mid-flight. | Server-side: the SSE handler detects disconnect within one event-loop tick and aborts the OpenAI stream; no orphan requests. |
| U11 | Chat at 360 px viewport width. | Sidebar is hidden; topnav is hidden; chat composer collapses to mobile padding; no horizontal scroll. |
| U12 | Set `LLM_MODEL=invalid-model` in env, hit `/api/chat/stream`. | Server emits an SSE `error` event with a sanitized message; the UI shows an inline error pill in the AI bubble. |
| U13 | `curl http://host/api/health` from a fresh boot. | Returns `{"status":"ok","ollama":true}` (moved from `/health`; `Dockerfile` `HEALTHCHECK` updated). |
| U14 | `curl http://host/chat` directly (page route, not API). | Returns the SPA `index.html` with 200, not a 404 — Fastify's SPA fallback handles it. |
| U15 | `curl http://host/api/does-not-exist`. | Returns 404 JSON (does NOT fall through to SPA — `/api/*` is excluded from the SPA fallback). |
| U16 | `npm test` after Phase 02 lands. | All prior tests still pass; new tests for the SQLite store, the SSE route handler, and Preact components (`Chat`, `Composer`, `Sidebar`, `QueueRow`) all green. |

## Functional requirements

### Routing convention (hard cut)

- **FR-1** **Every API route lives under `/api/*`.** Existing endpoints migrate from their current paths to `/api/*`:
  - `POST /chat` → `POST /api/chat`
  - `POST /chat/stream` → `POST /api/chat/stream` (new)
  - `GET /search` → `GET /api/search`
  - `GET /search/rag` → `GET /api/search/rag`
  - `POST /upload` → `POST /api/upload`
  - `GET /download/:filename` → `GET /api/download/:filename`
  - `GET /upload/progress` → `GET /api/upload/progress` (new)
  - `GET /health` → `GET /api/health`
- **FR-2** **Every UI page route lives under `/{page}`.** Pages: `/chat`, `/upload`. Visiting `/` redirects to `/chat`.
- **FR-3** Fastify MUST serve the Vite-built bundle from `web/dist/` as static. The SPA fallback handler returns `web/dist/index.html` for any non-API GET that didn't match a static file (FR-4 covers the `/api/*` exclusion).
- **FR-4** The SPA fallback handler MUST NOT serve `index.html` for paths under `/api/*` — those return a real 404 JSON.
- **FR-5** Direct URL access (e.g. pasting `http://host/upload` into the address bar) MUST serve the correct page (Fastify's `setNotFoundHandler` returns the SPA `index.html` for non-API GETs only).
- **FR-6** The SPA MUST use client-side routing (`wouter-preact`) so navigation between `/chat` and `/upload` does not full-reload the page.

### Sessions (multi-turn, persistent)

- **FR-7** Conversations MUST persist in SQLite (`conversations` and `messages` tables). Server startup MUST apply pending migrations from `src/db/migrations/*.sql`.
- **FR-8** `POST /api/sessions` MUST create a new conversation and return `{id, title, createdAt}`. `id` is a UUIDv4, matching the existing regex `^[A-Za-z0-9_-]{1,64}$`.
- **FR-9** `GET /api/sessions` MUST return the user's full session list, most-recently-updated first. Each item: `{id, title, createdAt, updatedAt, messageCount}`.
- **FR-10** `GET /api/sessions/:id` MUST return the session metadata. `404` if unknown.
- **FR-11** `GET /api/sessions/:id/messages` MUST return all turns in chronological order: `[{role: 'user' | 'assistant', content, sources?, createdAt}]`.
- **FR-12** `PATCH /api/sessions/:id` MUST support renaming (`{title: string}`). Other fields (`createdAt`, `updatedAt`, `messages`) are server-managed.
- **FR-13** `DELETE /api/sessions/:id` MUST remove the conversation and all its messages. Returns `204`.
- **FR-14** The server MUST auto-title a session from its first user message (first 60 chars, ellipsised) on the first assistant response.
- **FR-15** The server MUST bump `updatedAt` on each new turn (used for sidebar ordering).
- **FR-16** `CHAT_HISTORY_MAX_TURNS` (default 20) MUST bound the number of in-context turns sent to the LLM per request — same as Phase 01. Persistence is unbounded; the cap is only on context size.

### Chat streaming

- **FR-17** `POST /api/chat/stream` MUST accept the same body as `POST /api/chat` (`{q, sessionId?, limit?, expand?}`) and stream the response via Server-Sent Events.
- **FR-18** The SSE stream MUST emit typed events. Wire format (each event is a single SSE frame):
  - `event: meta\ndata: {"sessionId":"...","userMessageId":"..."}\n\n`
  - `event: sources\ndata: [{"fileName":"...","filePath":"...","chunk":"...","pageNumber":3,"headingPath":["..."],"score":0.87}]\n\n`
  - `event: token\ndata: {"text":"chunk of text"}\n\n` (one per OpenAI delta)
  - `event: done\ndata: {"messageId":"...","totalTokens":N}\n\n`
  - `event: error\ndata: {"message":"sanitized message"}\n\n`
- **FR-19** `event: token` events MUST be emitted for every `choices[0].delta.content` chunk from the OpenAI-compatible API when `stream: true` is set. The OpenAI SDK's async iterator is the source.
- **FR-20** The SSE handler MUST strip `` blocks (existing behavior in `openai-api-wrapper.ts:stripThinkTags`) and MUST NOT emit them as tokens.
- **FR-21** On client disconnect (browser closes the tab or navigates away), the server MUST abort the in-flight OpenAI stream within the next event-loop tick (using `AbortController` passed to `openai.chat.completions.create`). No orphan requests.
- **FR-22** The completed assistant message MUST be persisted to SQLite with the full final text and the sources array. `sources` is stored as JSON.
- **FR-23** Errors from the OpenAI API (4xx, 5xx, network) MUST emit a single `event: error` with a sanitized message (no API key, no stack trace) and close the stream with `event: done` immediately after.
- **FR-24** If the embedding step fails (Ollama 404, network), the handler MUST emit `event: error` with `"embedding unavailable"` and close.

### Upload progress

- **FR-25** `POST /api/upload` MUST continue to return `{success, fileName, chunksIndexed, fileId}` synchronously after the file is fully indexed. No SSE on upload itself.
- **FR-26** `GET /api/upload/progress` SSE endpoint MUST emit per-file progress events while any upload is in flight:
  - `event: file\ndata: {"fileName":"...","status":"queued|embedding|ready|failed","progress":0..100,"chunksIndexed":N,"error":null|"..."}\n\n`
  - `event: idle\ndata: {}\n\n` when no upload is active (initial state on subscription).
- **FR-27** An in-process `EventEmitter` MUST coordinate between the upload route and the progress SSE handler. The handler subscribes; the upload route publishes per-stage progress.

### Chat UI

- **FR-28** `/chat` MUST render the chat shell from `mockups/dockhoj-chat-v2.html`: topbar (brand, nav, status), sidebar (sessions), main area (toolbar, stream, composer).
- **FR-29** On mount, `/chat` MUST load the session list (`GET /api/sessions`) and either restore the session from URL hash or default to the most recent session (creating a new one if none exist).
- **FR-30** Clicking a session in the sidebar MUST set the URL hash to `#session=<id>` and load that session's messages via `GET /api/sessions/:id/messages`. Mid-stream aborts cleanly.
- **FR-31** Clicking the `+` in the "Sessions" header MUST `POST /api/sessions` and switch to it.
- **FR-32** Sending a message MUST `POST /api/chat/stream` with the user's text. Tokens append to the AI bubble in real time. Sources chips render when `event: sources` arrives. The bubble shows "thinking…" briefly before the first token only if the first token takes >200 ms (don't flash it).
- **FR-33** Markdown in assistant bubbles MUST be sanitized via DOMPurify before rendering (existing XSS protection, retained).
- **FR-34** Clicking a source chip MUST open an inline drawer with the full chunk text, page/heading metadata, and an "Open file" link to `/api/download/<file>`.
- **FR-35** The composer MUST auto-resize the textarea (1 to 6 lines). Enter sends, Shift+Enter inserts a newline.
- **FR-36** The toolbar model label (e.g. "llama-3.1 · 8k ctx") is **informational chrome** in this phase — it reflects the current `LLM_MODEL` env var. A real model picker is **out of scope**.
- **FR-37** The "Cite sources" / "Stream" / "Multi-doc" tags visible in the mockup's composer are **dropped** in this phase — they're decorative; their behaviour is either always-on (streaming, citations) or out of scope (multi-doc filtering). Documenting here so we don't re-add them later by accident.
- **FR-38** The "voice input" button is **dropped** in this phase. The compose row renders a single Send button.
- **FR-39** The topbar's "online · N chunks" status MUST reflect real values from `GET /api/status` returning `{chunks: number}`. The live pulse dot is on if `ollamaAvailable === true`, off otherwise.

### Upload UI

- **FR-40** `/upload` MUST render the upload shell from `mockups/dockhoj-upload-v2.html`: page head (eyebrow + H1 + paragraph + right-side chunk count), dropzone big (with floating orb), queue section.
- **FR-41** Files dropped on the dropzone MUST call `POST /api/upload` per file (bounded parallel ≤4) and subscribe to `GET /api/upload/progress` for live updates.
- **FR-42** The queue row MUST render per-file: file-type chip, name, size + estimated chunks, animated progress bar, percentage, status text (`queued → embedding → ready`), remove button.
- **FR-43** The right-aligned index count in the page head MUST update from `/api/status` on mount.
- **FR-44** Drag-over and drop states MUST use the design's hover transform and border-colour animation.

### Responsive

- **FR-45** Both pages MUST match the design's breakpoints: ≤960 px (mobile) collapses the sidebar and topnav, hides the model menu; ≤640 px reflows the upload queue to single-column.
- **FR-46** No horizontal scroll at any of the design's viewport widths (360, 390, 430, 600, 820, 1024, 1366, 1440, 1920).

### Build, package, deploy

- **FR-47** A new `web/` directory at repo root MUST contain the Vite + Preact SPA. It has its own `package.json`, `tsconfig.json`, and `vite.config.ts`.
- **FR-48** The Vite config MUST use `@preact/preset-vite` and `vite-plugin-singlefile` (or equivalent) to produce a single-file bundle. Bundle size target: < 300 KB gzipped (Preact + components + marked + DOMPurify + design CSS).
- **FR-49** The root `package.json` MUST add scripts:
  - `build:web`: `npm --prefix web install && npm --prefix web run build`
  - `dev`: orchestrates `tsx watch src/index.ts` for the server and `npm --prefix web run dev` for the client (uses `concurrently`).
- **FR-50** `Dockerfile` MUST copy `web/dist/` into `/app/web/dist` and the Fastify app MUST serve those assets. SPA fallback (`/*` → `index.html`, except `/api/*`) MUST be wired.
- **FR-51** `Dockerfile` MUST run `npm run build:web` during the image build before pruning dev dependencies, so the production image contains the built bundle.
- **FR-52** `Dockerfile` `HEALTHCHECK` MUST target `/api/health` (moved from `/health`).
- **FR-53** `Dockerfile.ollama` is unchanged from commit `3d2ace7`.
- **FR-54** `docker-compose.yml` MUST add a new named volume `conversations_data` mounted to `/app/data` where SQLite lives. The volume persists across container restarts and rebuilds.
- **FR-55** **Single-server-executable deployment:** one Fastify process (`node dist/index.js`) runs inside the app container. It serves the SPA static (`web/dist/`), all `/api/*` routes, and the SPA fallback. No nginx, no separate static-file server, no bundling complexity beyond Vite + tsc.

### Tests

- **FR-56** Unit tests MUST cover the SQLite store: conversation CRUD, message append, message ordering, `updatedAt` bumping, cascade delete.
- **FR-57** Unit tests MUST cover the SSE parser on the client side: event-type dispatch, malformed-line tolerance, reconnect on dropped connection.
- **FR-58** Route tests (via `fastify.inject`) MUST cover:
  - `POST /api/sessions` creates and returns the new session.
  - `GET /api/sessions/:id/messages` returns the full history.
  - `POST /api/chat/stream` emits the expected SSE event sequence for a stubbed OpenAI stream.
  - `POST /api/chat/stream` aborts the in-flight OpenAI request when the client disconnects (use a delayed handler).
  - `GET /api/upload/progress` emits `event: idle` when no upload is in flight.
  - `GET /api/health` returns the same shape the old `/health` did.
  - The SPA fallback handler returns `index.html` for unknown page routes and 404 JSON for unknown `/api/*` routes.
- **FR-59** Component tests (`@testing-library/preact` + `vitest`) MUST cover `Composer` (Enter sends, Shift+Enter newline, autosize), `Sidebar` (session list, switching, +), `Bubble` (token append, source chip render), and `QueueRow` (progress updates).
- **FR-60** E2E test MUST verify the upload → chat flow against the running Docker stack: upload a sample markdown via `POST /api/upload`, ask a question about it via `POST /api/chat/stream`, see a streamed response with sources.

## Non-functional requirements

- **NFR-1** Time-to-first-token on `POST /api/chat/stream` MUST be ≤ 500 ms p95 after the request starts (excluding Ollama embed latency, which is bounded by `EMBEDDING_CONCURRENCY`).
- **NFR-2** Bundle size MUST be < 300 KB gzipped.
- **NFR-3** The conversation list MUST load in < 100 ms for ≤ 1000 sessions (single SQLite query with index on `updatedAt`).
- **NFR-4** SQLite MUST use `WAL` journal mode for concurrent reads during writes (the progress SSE handler reads while uploads write).
- **NFR-5** Test coverage: project overall ≥ 80% lines (matches Phase 01's threshold). New code (`src/db/`, `src/services/conversations.ts`, `src/services/stream-chat.ts`, `web/src/components/`, `web/src/services/`) MUST have ≥ 80% line coverage each.
- **NFR-6** All new dependencies MUST be MIT / Apache / BSD. `better-sqlite3` is MIT.
- **NFR-7** No `console.log` / `debug print` in production code.
- **NFR-8** No commented-out code committed.
- **NFR-9** **Routing convention is uniform and load-bearing.** New endpoints MUST live under `/api/*`; new pages MUST live under `/{page}`. The SPA fallback MUST NOT serve `index.html` for `/api/*` paths. This is a forward-looking constraint, not just a one-time migration.

## Out of scope (this phase)

- LLM tool-use agent loop (`expand=auto`, `get_neighbor_chunks`, etc.). Phase 03.
- Multi-user / authn / authz.
- Hierarchical / parent-child chunk storage.
- Cross-encoder re-ranking.
- Document deletion endpoint (still deferred; see Phase 01).
- Voice input. Push notifications. Native mobile shell.
- Migrating the in-memory `conversations` Map to a backend store (we're moving straight to SQLite; the Map goes away).
- A "Documents" listing page (not in v2 design canon; deferred).
- A home/launcher page (`rag-app.html` is intentionally dropped from scope — see the design-folder cleanup).
- A true single-binary executable (e.g. via `bun build --compile` or `pkg`). The "single-server-executable" requirement is met by a single Node process. See OD-8.

## Constraints & assumptions

- **Single user, single tenant.** No auth, no per-user isolation in SQLite.
- **No new runtime services.** SQLite lives in-process via `better-sqlite3`. No external DB.
- **Single instance assumption.** SQLite handles a single writer; multi-instance DocKhoj is a future concern.
- **OpenAI-compatible API.** Streaming uses `stream: true` on `chat.completions.create` — supported by OpenAI, MiniMax, and other OpenAI-compatible providers.
- **Routing split:** Fastify's static plugin handles `web/dist/*` first (literal file lookup). The SPA fallback handler returns `index.html` for non-API GETs only. `/api/*` returns JSON 404 on unknown paths. This means SPA paths and API paths can never collide.
- **Existing `CHAT_HISTORY_MAX_TURNS` semantics.** Phase 01's bounded-context cap is preserved as the in-LLM-context cap. Persistence is unbounded.
- **Backward compatibility on response shapes:** `POST /api/chat`, `GET /api/search`, `GET /api/search/rag`, `POST /api/upload`, `GET /api/download/:filename`, `GET /api/health` MUST keep their current response shapes. The breaking change is to the **path**, not the shape.
- **Backward compatibility on paths:** none. This is a clean cut. The old paths are removed (or kept as 404s). Documented in the README's "Breaking changes from Phase 01" section.

## Acceptance criteria

The phase is done when **all** of the following are true:

1. `npm run build` (server) and `npm --prefix web run build` (client) both succeed clean.
2. `npm test` passes with project line coverage ≥ 80% and the new code's coverage targets met.
3. A fresh `docker compose up` boots the app; `/chat` renders with the v2 visual contract (topbar, sidebar, composer) at all the design-spec viewports.
4. Sending "hello" in a new chat returns a streamed response whose tokens arrive over ≥ 5 distinct SSE `event: token` lines (not a single chunk).
5. After 3 turns, restarting the container (`docker compose restart app`) leaves the session and its 3 turns in the sidebar and on reload.
6. Closing the tab mid-stream within 1 second of the first token: the server log shows "abort requested" and the OpenAI request is cancelled (no orphaned LLM call observed in the LLM provider's dashboard).
7. Uploading a 200 KB markdown file shows live queue progress; final state is `ready` with non-zero `chunksIndexed`.
8. At 360 × 800 px viewport: no horizontal scroll on `/chat` or `/upload`; sidebar hidden; composer usable.
9. `curl http://host/api/health` returns `{"status":"ok","ollama":true}`; the `Dockerfile` `HEALTHCHECK` line targets `/api/health` and the container reports healthy.
10. `curl http://host/api/does-not-exist` returns 404 JSON (NOT the SPA `index.html`).
11. Reviewer (the user) has signed off on `design.md` and the `TASKS.md` plan.

## Open questions (need user input before / during implementation)

- **OQ-1** — Framework: **Preact + Vite** (recommended) vs **React + Vite**? Same React API; Preact is ~3 KB runtime, React is ~45 KB. Both work; Preact is the better fit for a self-hosted single-user tool. Lock to Preact unless you want React specifically.
- **OQ-2** — SQLite driver: **`better-sqlite3`** (synchronous, MIT, the de-facto Node choice) vs **`node:sqlite`** (Node 22+ built-in experimental, no native build) vs **`sql.js`** (WASM, runs in-process, no native build, but slower for large DBs). **Recommendation: `better-sqlite3`.** Smallest, fastest, simplest.
- **OQ-3** — SPA fallback rule: catch-all `setNotFoundHandler` returns `index.html` for non-`/api/*` GETs. Confirm that's OK vs. an allowlist of explicit SPA paths.
- **OQ-4** — SessionId reuse: keep the existing regex `^[A-Za-z0-9_-]{1,64}$` (UUIDv4 fits), or relax it to allow spaces/punctuation? **Recommendation: keep the regex.** UUIDs are user-invisible; the regex is a defense-in-depth against injection.
- **OQ-5** — Auto-title from first message: first 60 chars, ellipsised. OK?
- **OQ-6** — Source-chip UX: inline drawer (recommended, in-place, no nav) vs separate route. **Recommendation: inline drawer.**
- **OQ-7** — Topbar chunk-count: live from `/api/status`? Or drop the count entirely? **Recommendation: live from `/api/status`.** Trivial to add, makes the chrome honest.
- **OQ-8** — "Single-server-executable" interpretation: **default = single Fastify process** (one `node dist/index.js` inside the app container). **Optional future path = true single binary** via `bun build --compile` (modern, fast, smaller) or `pkg` (mature, works with Node deps). The default satisfies the requirement; the binary path is a follow-up if/when distribution becomes a hard requirement.