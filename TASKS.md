# TASKS

Active source of truth for work in flight. Tasks ordered by execution sequence. Update status as work progresses.

> Phase 01 is **done** per [`docs/specs/phase-01-smart-chunker-and-cleanup/`](./docs/specs/phase-01-smart-chunker-and-cleanup/) and the git log (commits `9bb6cf3` … `014a4f2`). Its task entries below are kept as a historical record; their `Status: todo` markers are stale and intentionally not flipped — the spec README and git history are the canonical sources for what shipped.

---

# Phase 02 — Frontend, Streaming, and Persistence

Spec: [`docs/specs/phase-02-frontend-streaming-and-persistence/`](./docs/specs/phase-02-frontend-streaming-and-persistence/).

## T22 — Add new dependencies

- **Description:** Install `better-sqlite3`, `wouter-preact`, `@preact/preset-vite`, `vite`, `vite-plugin-singlefile`, `@testing-library/preact`, `happy-dom`, `marked`, `dompurify` (moved from CDN to npm), `concurrently` (dev). All MIT. Add `web/package.json` for the SPA workspace.
- **Maps to FR:** FR-22 (deps allowlist), T22 setup
- **Maps to design:** §Tech stack
- **Acceptance:** `npm install` at root + `npm --prefix web install` both succeed; lockfile updated; `web/package.json` lists SPA deps.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T23 — Create web/ scaffold

- **Description:** Create `web/` with `index.html`, `src/main.tsx`, `src/App.tsx`, `vite.config.ts`, `tsconfig.json`, `package.json`. `@preact/preset-vite` + `vite-plugin-singlefile` configured. `npm --prefix web run dev` serves on port 5173. `npm --prefix web run build` outputs `web/dist/`.
- **Maps to FR:** FR-47, FR-48
- **Maps to design:** §Module layout
- **Acceptance:** Empty Preact app renders at `localhost:5173`; `web/dist/index.html` is produced by `build`.
- **Depends on:** T22
- **Estimate:** S
- **Status:** done

## T24 — Extract design tokens + base styles

- **Description:** Copy `:root` from `mockups/dockhoj-chat-v2.html` into `web/src/styles/tokens.css` (CSS custom properties). Add `base.css` (reset, body, selection). Add `animations.css` (aurora, grain, grid-overlay, pulse, rise, caret, blink). Verify visual parity with the mockup when applied to a stub page.
- **Maps to FR:** FR-25, FR-40, FR-45, FR-46
- **Maps to design:** §Tech stack, §Module layout
- **Acceptance:** `tokens.css` is the single source of design tokens; running a stub page produces identical colors/typography/motion to the mockup.
- **Depends on:** T23
- **Estimate:** S
- **Status:** done

## T25 — Build static UI scaffold

- **Description:** Build `TopBar`, `Sidebar` (with seed sessions), `Bubble`, `Composer` (no-op), `Dropzone`, `QueueRow` (static). Render both routes (`/chat`, `/upload`) with sample data. Verify visual contract at all design-spec viewports. Add responsive styles (≤960 px, ≤640 px).
- **Maps to FR:** FR-25, FR-40, FR-42, FR-45, FR-46
- **Maps to design:** §Module layout, §State management
- **Acceptance:** Manual screenshot at 360 / 1024 / 1440 matches the mockup's layout at those widths; no horizontal scroll; sidebar collapses correctly.
- **Depends on:** T24
- **Estimate:** L
- **Status:** done

## T26 — SQLite layer + migration runner

- **Description:** Add `src/db/` with `index.ts` (better-sqlite3 singleton + WAL pragma + foreign_keys), `migrations/001_init.sql` (`conversations`, `messages`, `_migrations`, indexes), `migrate.ts` (apply pending migrations on startup, idempotent). Wire `migrate(db)` into `index.ts` startup before `initCollection()`.
- **Maps to FR:** FR-7, NFR-4
- **Maps to design:** §Data model, §Key algorithms > Migration runner
- **Acceptance:** Fresh container boots, `_migrations` table is created, `001` is recorded; second boot is a no-op; `:memory:` test DB applies the migration cleanly.
- **Depends on:** T22
- **Estimate:** M
- **Status:** done

## T27 — ConversationStore

- **Description:** Implement `services/conversations.ts`: `ConversationStore` class with `list`, `get`, `create`, `rename`, `delete`, `appendUserMessage`, `appendAssistantMessage`, `listMessages`, `setGeneratedTitle` (respects FR-15b — only overwrites if current title is `"New chat"` or a generated prefix), `bumpUpdatedAt`. Cascade delete via FK.
- **Maps to FR:** FR-7, FR-8, FR-9, FR-10, FR-11, FR-12, FR-13, FR-16
- **Maps to design:** §Data model, §API surface > Internal
- **Acceptance:** Unit tests against `:memory:` DB cover all CRUD paths, message ordering, cascade delete, `setGeneratedTitle` rejects overwrite of user-renamed titles, `updatedAt` bump on append.
- **Depends on:** T26
- **Estimate:** M
- **Status:** done

## T28 — Sessions routes

- **Description:** Add `routes/api-sessions.ts` with `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/messages`, `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id`. Validation: `sessionId` regex; `title` non-empty.
- **Maps to FR:** FR-8, FR-9, FR-10, FR-11, FR-12, FR-13
- **Maps to design:** §API surface > HTTP
- **Acceptance:** Route tests via `fastify.inject` cover each endpoint's happy path + 404 + validation. Sidebar reload test: list returns most-recently-updated first.
- **Depends on:** T27
- **Estimate:** M
- **Status:** done

## T29 — Path migration cut (existing endpoints → /api/*)

- **Description:** Move every existing API endpoint from its old path to `/api/*`:
  - `POST /chat` → `POST /api/chat`
  - `GET /search` → `GET /api/search`
  - `GET /search/rag` → `GET /api/search/rag`
  - `POST /upload` → `POST /api/upload`
  - `GET /download/:filename` → `GET /api/download/:filename`
  - Add `routes/api-health.ts` for `/api/health` (moved from `/health`).
  - Update `routes/upload.ts` to publish progress events to `uploadBus`.
  - Update all existing tests + README to use the new paths.
- **Maps to FR:** FR-1, FR-2, FR-9 (breaking change)
- **Maps to design:** §API surface > HTTP
- **Acceptance:** All existing tests green after path updates. README "API endpoints" section reflects new paths. Old paths return 404 (not redirects).
- **Depends on:** T28
- **Estimate:** M
- **Status:** done

## T30 — Wire SPA to /api/sessions

- **Description:** Add `web/src/services/sessions.ts` (typed fetch: `list`, `get`, `create`, `rename`, `delete`, `listMessages`). Replace `Sidebar.tsx` seed data with real session list. Click-to-switch: URL hash + `localStorage`. Render `<Bubble />` history for the active session.
- **Maps to FR:** FR-29, FR-30, FR-31
- **Maps to design:** §State management
- **Acceptance:** SPA lists real sessions, switches between them, persists selection across reload, displays the prior messages.
- **Depends on:** T28, T25
- **Estimate:** M
- **Status:** done

## T31 — OpenAI streaming wrapper (additive) + title generator service

- **Description:** Add `streamChatCompletionRaw(messages, signal)` to `services/openai-api-wrapper.ts`: yields `{text}` chunks from `openai.chat.completions.create({ stream: true }, { signal })`. Existing `createChatCompletion` stays for the non-streaming `/api/chat` endpoint. Also create `services/title-generator.ts` with `generateConversationTitle(userMsg, assistantMsg, signal)` (5–8 word title, low temperature, max_tokens 30, strips quotes/punctuation) and `fallbackTitle(userMsg)` (60-char user prefix with ellipsis).
- **Maps to FR:** FR-14, FR-15, FR-15a, FR-15b, FR-20
- **Maps to design:** §Key algorithms > OpenAI streaming wrapper, §Key algorithms > Title generator
- **Acceptance:** Unit tests with stubbed OpenAI client assert: (a) stream yields chunks in order, abort signal propagates; (b) `generateConversationTitle` returns a 5–8 word string with quotes/punctuation stripped, falls back gracefully on 4xx/5xx; (c) `fallbackTitle` clamps to 60 chars with ellipsis.
- **Depends on:** —
- **Estimate:** M
- **Status:** done

## T32 — Stream orchestrator

- **Description:** Add `services/stream-chat.ts`: `streamChatCompletion(params, signal)` async generator. Embeds the query, runs Qdrant search, applies expand mode, builds the prompt from context + history, yields `StreamEvent` (sources first, then token, then done).
- **Maps to FR:** FR-17, FR-18, FR-19, FR-20
- **Maps to design:** §Key algorithms > SSE chat handler
- **Acceptance:** Stub-friendly tests: with a fake OpenAI stream + fake Qdrant + fake embed, the generator yields the expected event sequence.
- **Depends on:** T31
- **Estimate:** M
- **Status:** done

## T33 — SSE route + client SSE parser + post-`done` title event

- **Description:** Add `POST /api/chat/stream` route handler in `routes/chat.ts` using `streamChatCompletion`. Set SSE headers (`text/event-stream`, `X-Accel-Buffering: no`). Handle disconnect via `AbortController`. After `event: done`, fire off `generateConversationTitle` async; on completion emit `event: title` (best-effort — write to a closed stream is a no-op). Add `web/src/services/stream.ts` (POST + ReadableStream SSE parser) handling the new `title` event type without breaking on parse errors. Wire `Bubble.tsx` to render streamed tokens live; `Composer.tsx` to send via `openChatStream`; `Sidebar.tsx` to update a session's title on `event: title` (silently no-op if the session is no longer current). Persist completed assistant message. Update `POST /api/chat` (non-stream) to include a `title` field — concurrent LLM title gen awaited during the response.
- **Maps to FR:** FR-14, FR-15, FR-15a, FR-15b, FR-18, FR-19, FR-20, FR-21, FR-22, FR-23, FR-24, FR-32, FR-33
- **Maps to design:** §Key algorithms > SSE chat handler, §Key algorithms > Sync title delivery, §Key algorithms > SSE parser
- **Acceptance:** Route test asserts event sequence including `event: title` after `event: done`. Disconnect simulation: `reply.raw.close()` mid-stream causes `AbortController.abort()` to be called AND the post-`done` title write is silently dropped (no error). Client SSE parser test handles single + multiple + malformed frames including the new `title` event. Sync `/api/chat` test asserts `title` is non-null in response.
- **Depends on:** T32, T30, T31
- **Estimate:** L
- **Status:** done

## T34 — /api/status route + TopBar wiring

- **Description:** Add `routes/api-status.ts`: `GET /api/status` returns `{chunks: number, ollamaAvailable: bool}`. `chunks` from `qdrant.count(COLLECTION)`. `ollamaAvailable` from `isOllamaAvailable()`. Wire `TopBar.tsx` to fetch on mount, render `N chunks` and the live pulse dot.
- **Maps to FR:** FR-39, FR-43
- **Maps to design:** §API surface > HTTP
- **Acceptance:** Topbar shows real chunk count and live dot. Route test returns the right shape.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T35 — Upload progress via XHR (no SSE)

- **Description:** Adopt the simpler primitive for upload progress: `XMLHttpRequest.upload.onprogress` reports transport progress (bytes flowing to the server) natively in the browser; the final `success` / `failed` status comes back in the same POST `/api/upload` response. No server-side `EventEmitter`, no `GET /api/upload/progress` SSE channel, no race-on-subscribe semantics. The earlier T35 SSE design was over-engineered for a single-user self-hosted app where uploads are infrequent (see `design.md` §Upload progress for the rationale). This task is folded into **T36** below; the T35 line is kept only as a historical marker.
- **Maps to FR:** FR-25, FR-26, FR-27
- **Maps to design:** §Key algorithms > Upload progress
- **Acceptance:** Documented in T36.
- **Depends on:** —
- **Estimate:** —
- **Status:** done

## T36 — Wire upload UI to live progress

- **Description:** Add `web/src/services/upload.ts` with `uploadFile(file, onProgress?, signal?)`: wraps XHR (rather than `fetch`) so we get `upload.onprogress` for transport progress while still supporting `AbortSignal` for cancel. The returned promise resolves to `{ success, fileName, chunksIndexed, fileId }` on 200 or rejects with `error` on failure. Update `Upload.tsx` to:
  - On file drop, add a queue row in `status: 'uploading'`, `progress: 0`.
  - `uploadFile` concurrently (bounded ≤4). Wire `onProgress` to update the row's `progress` (0..100).
  - When the XHR reaches 100%, transition the row to `status: 'indexing'`, indeterminate. When the POST resolves, set `status: 'ready'` with `chunksIndexed`, or `status: 'failed'` with the error message.
  - "×" button on each row calls `signal.abort()` and removes the row.
- **Maps to FR:** FR-25, FR-26, FR-27, FR-40, FR-41, FR-42, FR-44
- **Maps to design:** §Module layout, §Key algorithms > Upload progress
- **Acceptance:** Drop 1 small file → row appears, progress bar fills 0→100, row transitions to `ready` with the server's `chunksIndexed`. Drop a non-existent / corrupt file → row ends `failed` with the server's error message. Mock XHR test asserts `upload.onprogress` ticks drive the row's progress field and the POST response drives the final state. Existing `POST /api/upload` integration test still passes.
- **Depends on:** T25
- **Estimate:** M
- **Status:** todo

## T37 — Source drawer

- **Description:** Add `SourceDrawer.tsx` (inline drawer, slide-in from right). `Bubble.tsx` source chip click opens the drawer with the full chunk text, page/heading metadata, and an "Open file" link to `/api/download/<file>`. ESC + backdrop click close the drawer.
- **Maps to FR:** FR-34
- **Maps to design:** §Module layout
- **Acceptance:** Component test: clicking a source chip opens the drawer with the right content. ESC closes. The drawer's "Open file" link points to `/api/download/...`.
- **Depends on:** T25
- **Estimate:** M
- **Status:** done

## T38 — SPA fallback + Dockerfile + docker-compose

- **Description:** Add `server/spa.ts`: mounts `web/dist/` via `@fastify/static` with `fallthrough: true`, then `setNotFoundHandler` returns `index.html` for non-`/api/*` GETs (404 JSON otherwise). Update `Dockerfile` to run `npm run build:web` and update `HEALTHCHECK` to `/api/health`. Update `docker-compose.yml` to add `conversations_data` volume mounted at `/app/data` with `SQLITE_PATH=/app/data/conversations.db`.
- **Maps to FR:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-50, FR-51, FR-52, FR-54, FR-55
- **Maps to design:** §Key algorithms > SPA fallback, §Deployment
- **Acceptance:** `curl http://host/api/does-not-exist` returns 404 JSON; `curl http://host/anything` returns the SPA `index.html`. `Dockerfile` builds clean, `docker compose up` reports the app `healthy` after boot.
- **Depends on:** T29, T23
- **Estimate:** M
- **Status:** done

## T39 — Root package.json scripts

- **Description:** Add `build:web` (delegates to `npm --prefix web`), `dev` (uses `concurrently` to run server + Vite), `test` (vitest workspaces including `web/src`), `start` (`node dist/index.js`). Keep existing `build`, `coverage` scripts.
- **Maps to FR:** FR-49
- **Maps to design:** §Module layout
- **Acceptance:** `npm run build:web && npm run build` produces both bundles. `npm test` runs server and web tests. `npm run dev` starts both processes.
- **Depends on:** T23
- **Estimate:** S
- **Status:** done

## T42 — SPA fallback route tests

- **Description:** `tests/routes/spa-fallback.test.ts`. Cover: `GET /chat` returns 200 + `Content-Type: text/html`; `GET /upload` returns 200 + HTML; `GET /api/does-not-exist` returns 404 + JSON; `GET /` redirects to `/chat`. Cover static asset lookup vs. fallback (e.g. `GET /assets/index.js` returns the file when present, falls through otherwise).
- **Maps to FR:** FR-1, FR-2, FR-3, FR-4, FR-5
- **Maps to design:** §Testing strategy
- **Acceptance:** All routing cases covered; tests fail if the SPA fallback regresses to leaking the shell into `/api/*` or leaking JSON into page routes.
- **Depends on:** T38
- **Estimate:** S
- **Status:** done

## T43 — Coverage thresholds + README + final verification

- **Description:** Update `vitest.config.ts` thresholds: project overall ≥ 80% lines; new code (`src/db/`, `src/services/conversations.ts`, `src/services/stream-chat.ts`, `web/src/services/`) ≥ 80% lines each (component tests removed per T40 cleanup). README update: new env vars (`SQLITE_PATH`, `WEB_DIST`), new `/api/*` paths in the API section, Docker compose volume, `build:web` script, breaking-changes note for the path migration.
- **Maps to FR:** all (verification), NFR-5
- **Maps to design:** §Testing strategy, §Deployment
- **Acceptance:** `npm run coverage` exits 0 with thresholds met. `docker compose up` smoke test: app healthy, `/api/health` returns ok, `/chat` renders, upload + chat end-to-end works, conversation persists across `docker compose restart app`.
- **Depends on:** T29, T33, T38, T42
- **Estimate:** M
- **Status:** done

## T44 — Markdown rendering in chat assistant bubbles (PRIORITY)

- **Description:** Assistant responses from the LLM come back as Markdown (bold, italic, code fences, lists, etc.) but the SPA currently renders them as plain text. Add `web/src/services/markdown.ts`: wraps `marked.parse()` with `DOMPurify.sanitize()` per FR-33 (XSS protection). Wire `Bubble.tsx` so assistant bubbles render the markdown as sanitized HTML (via `dangerouslySetInnerHTML`); user bubbles stay plain text. Streaming tokens should be re-rendered as markdown on each tick (cheap re-sanitize per chunk). The `bubble .text` styles in `bubble.css` already cover `b`, `em`, `code`, `pre`, `ul`, `ol`, `li` so the rendered markdown picks them up.
- **Maps to FR:** FR-33
- **Maps to design:** §State management (SPA client pipeline)
- **Acceptance:** A response containing `**bold**` and `` `code` `` renders as bold text and inline code in the assistant bubble. Adversarial `<script>alert(1)</script>` inside the response is sanitized to nothing. Streaming continues to work — the bubble re-renders on each token tick with markdown applied to the accumulated text.
- **Depends on:** T33 (streaming pipeline already produces text)
- **Estimate:** S
- **Status:** done

## T45 — Chat scroll container (PRIORITY)

- **Description:** On `/chat`, scrolling inside the conversation area scrolls the whole page (the body). The `.stream` element has `overflow-y: auto` but its parent `.chat-shell` has `height: calc(100vh - 65px)` while the body has `min-height: 100vh` (no fixed height), so the body grows to fit the chat-shell's content and the page scrolls. Fix: restructure body / main / chat-shell so the chat conversation area is a self-contained scroll container. Body becomes `height: 100dvh; display: flex; flex-direction: column; overflow: hidden`. Topbar stays flex: 0 0 auto. Main becomes `flex: 1; min-height: 0; overflow: hidden`. .chat-shell becomes `height: 100%`. The /upload page wraps its content in `overflow-y: auto` so it still scrolls inside the same fixed viewport.
- **Maps to FR:** FR-45 (responsive — broken: viewport-relative sizing)
- **Maps to design:** §Module layout, §Frontend design
- **Acceptance:** On `/chat`, scrolling inside the conversation bubbles does NOT scroll the page; the page itself stays fixed. On `/upload`, scrolling inside the page scrolls within the upload-shell (not the body). Both pages work at 360 × 800 px and 1440 × 900 px without horizontal or vertical scroll bleed.
- **Depends on:** T33
- **Estimate:** S
- **Status:** done

## T46 — Chat layout refactor + composer pinned to bottom

- **Description:** The chat column didn't fill the viewport (composer floated ~⅓ down the page on first paint) and the layout buried the sidebar-vs-chat split inside one route component. Refactor: lift `<Sidebar>` to `App.tsx` so it sits next to `<TopBar>` in the page chrome; replace the `.chat-shell` CSS Grid (with its implicit-row auto-sizing trap) with pure flexbox — `<main class="layout">` is the flex row containing Sidebar + Chat; `<section class="chat">` is the flex column containing toolbar / stream / composer. Sidebar gets `flex: 0 0 300px`. Composer gets `flex-shrink: 0` so a long stream can't squeeze it. Sessions state, the streaming turn, and all session handlers move from `Chat.tsx` up to `App.tsx`; `Chat.tsx` becomes a presenter taking `activeSession, loading, messages, pending, onSubmit` as props. `App.tsx` uses `useLocation` to render Sidebar only on `/chat` (upload stays single-column). Root cause of the empty bottom space: body had only one flex child, Preact's `#app` mount point, which defaulted to `display: block` and sized to its content — so TopBar + `<main>` (both inside `#app`) couldn't grow past the content height. `#app` is now `flex: 1; display: flex; flex-direction: column` so it claims the body, and the flex children distribute the remaining height correctly.
- **Maps to FR:** FR-45 (responsive layout — broken: composer floating mid-screen)
- **Maps to design:** §Module layout, §Frontend design
- **Acceptance:** At 1440 × 900, the chat column fills the viewport (sidebar 300 px on the left, chat filling the rest, composer anchored to the bottom). At 420 × 900 the sidebar is hidden and the chat fills the screen. The `/upload` page stays single-column with no sidebar. The composer never gets squeezed by a long stream. All 200 vitest tests still pass.
- **Depends on:** T25 (sidebar/composer static scaffold)
- **Estimate:** M
- **Status:** done

## T47 — restart.sh hot-iteration loop

- **Description:** `restart.sh` tore down and rebuilt all three containers (including the slow Ollama image that bakes in the embedding model on build) on every run, which made the project's "pre-commit" loop take minutes for a 5-line CSS change. Split into two modes: `hot` (default) rebuilds + recreates only the `app` container, leaves Ollama + Qdrant running, and brings them up lazily if they're not yet running; `--full` does the clean teardown + `--no-cache` rebuild + all-services-up for fresh clones or compose changes.
- **Maps to FR:** NFR-7 (developer iteration loop)
- **Maps to design:** §Build & run
- **Acceptance:** After a CSS change, `./restart.sh` finishes in seconds (only app container recreated, Ollama + Qdrant untouched). `./restart.sh --full` still produces a clean fresh-clone boot. Hot path skips the Ollama image build when it's already cached.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T48 — Persist Qdrant + SQLite to ~/.dockhoj

- **Description:** SQLite (conversations + messages) lived inside the app container's writable layer and was wiped every time `./restart.sh` force-recreated the container. Qdrant was bind-mounted to `./qdrant_data/` (project root), which persisted across restarts but fragmented DocKhoj state across the repo. Move both under a single host directory: `${DOCKHOJ_HOME}` (default `~/.dockhoj/`) with `db/` for SQLite and `qdrant/` for Qdrant. `restart.sh` exports `DOCKHOJ_HOME`, creates the dirs on first run, and runs a one-shot `migrate_state` that lifts `./qdrant_data/*` → `~/.dockhoj/qdrant/` and docker-cps the SQLite from the running app container → `~/.dockhoj/db/` (with a `wal_checkpoint(TRUNCATE)` first so the copy is a single coherent file). The hot path now also force-recreates Qdrant so it picks up the new bind mount — otherwise a container restart that doesn't touch Qdrant would leave it reading the old path while new writes went to the new one. The migration copies but never deletes the old `./qdrant_data/` — while Qdrant is running its files are mmap-locked and a host `rm` hits "Permission denied"; the user can `rm -rf ./qdrant_data` manually once they confirm the new bind mount is in use. README updated to describe the layout and the `DOCKHOJ_HOME` override.
- **Maps to FR:** NFR-1 (data persistence), NFR-5 (state survives restart)
- **Maps to design:** §Build & run
- **Acceptance:** Run `./restart.sh` twice — sessions listed by `/api/sessions` are identical before and after. Run `./restart.sh --full` — sessions + Qdrant vectors still present. `docker inspect dockhoj-qdrant` shows the bind mount under `/home/$USER/.dockhoj/qdrant`. `docker inspect dockhoj-app` shows `/app/data` mounted from `/home/$USER/.dockhoj/db`. `DOCKHOJ_HOME=/tmp/foo ./restart.sh` boots cleanly with state isolated to `/tmp/foo/`.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

## T49 — Auto-scroll chat to bottom on session load

- **Description:** The `.stream` container (`web/src/routes/Chat.tsx`) did not auto-scroll on mount or on session switch — opening a long conversation or switching to one in the sidebar left the user pinned at the top. Add a `streamRef` + `lastScrolledFor` ref pair and a `useEffect` keyed on `[activeSession?.id, messages.length]` that calls `el.scrollTo({ top: scrollHeight, behavior: 'auto' })` once per session id. Guard with `if (messages.length === 0) return` so the brief race between `setActiveId(id)` and the resolved `listMessages(id)` doesn't lock out the real scroll. Token streaming is intentionally NOT a trigger — once landed at the bottom, the user's reading position is preserved across streaming growth. `behavior: 'auto'` overrides the container's `scroll-behavior: smooth` so the initial jump is instant, not tweened.
- **Maps to FR:** UX-49 (implied by the spec's chat-column contract)
- **Maps to design:** §Module layout (Chat route)
- **Acceptance:** `./restart.sh` boots the stack; load `/chat` for a session with prior messages and the stream scrolls to the bottom on mount; switch to a second session in the sidebar and the new conversation's most recent message is visible without a manual scroll; during a streaming response, manually scrolling up to read history is NOT yanked back to the bottom; the existing chat tests in `web/tests/routes/Chat.test.tsx` cover all three cases plus the loading-empty and load-race races and pass under `npm test`.
- **Depends on:** —
- **Estimate:** S
- **Status:** done

---

# Phase 01 — Smart Chunker & Cleanup

**Status:** done (see [`docs/specs/phase-01-smart-chunker-and-cleanup/`](./docs/specs/phase-01-smart-chunker-and-cleanup/))

> The task entries below are historical; status markers are not maintained. Git log + the spec README are the canonical sources of truth for what shipped.

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

# Phase 03 — Document Deletion and Agentic RAG

Spec: [`docs/specs/phase-03-document-deletion-and-agentic-rag/`](./docs/specs/phase-03-document-deletion-and-agentic-rag/).

## Status

- **Planning.** Spec folder written (README + requirements + design + TASKS); awaiting user sign-off before implementation begins.
- Tasks live in the spec folder: `docs/specs/phase-03-document-deletion-and-agentic-rag/TASKS.md` (T44 … T56). The entries below are summary pointers only.
- Open questions (`docs/specs/phase-03-document-deletion-and-agentic-rag/requirements.md` → Open questions) need user input before / during implementation.

## Track A — Document deletion

- **T44** — `documents` table + `DocumentStore` + upload wiring + status count.
- **T45** — Qdrant `deleteByFilePath` + `/api/documents` routes.
- **T46** — SPA: `DocumentsList` + integrate into `/upload`.

## Track B — Agentic RAG

- **T47** — Migration `004_tool_calls.sql` + `ConversationStore.appendAssistantMessage(...toolCalls)`.
- **T48** — `services/agent-tools.ts` (the four tool implementations).
- **T49** — `streamChatCompletionWithTools` in `openai-api-wrapper.ts`.
- **T50** — `services/agent-loop.ts` (bounded loop, token cap).
- **T51** — `routes/chat-stream.ts` extended to dispatch to agentic path; persist `toolCalls`.
- **T52** — Client SSE: `tool_call`/`tool_result` handling + bubble chips.
- **T53** — Chat toolbar: expand-mode toggle.

## Wrap-up

- **T54** — Coverage thresholds + README updates + final integration test pass.

---

## Notes

- Every commit must run the test suite and pass before being marked `done` (per standing CLAUDE.md §3).
- If reality diverges from design during implementation, update `design.md` first, then code.
- If a task turns out to be larger than estimated, split it here rather than letting it sprawl.
- Phase 01 and Phase 02 task entries are historical record. Their `Status:` fields reflect the spec README (`done`); consult the git log for commit-level detail.
- Phase 03 tasks live in `docs/specs/phase-03-document-deletion-and-agentic-rag/TASKS.md`. The summary list above is for at-a-glance navigation only.