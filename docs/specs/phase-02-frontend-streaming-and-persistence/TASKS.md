# Tasks — Phase 02

**Phase:** Frontend, Streaming, and Persistence
**Spec:** [`README.md`](./README.md), [`requirements.md`](./requirements.md), [`design.md`](./design.md)
**Status:** done (per spec README + git log `2c81035` … `6425682`)

> T22 – T43 are the spec's original task list. T44 – T49 are post-spec priority tasks that landed as follow-ups after the spec was frozen (markdown rendering, scroll/layout fixes, infra iteration loop, persistence overhaul, auto-scroll on session load). All are `done`.

---

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

## T35 — Upload progress via XHR (no SSE) — historical marker

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
- **Status:** done
- **Shipped in:** `bea88d6 feat(web): wire upload UI to live progress (XHR.onprogress)`, with `3ee9d4e refactor(upload): drop SSE progress bus; use XHR onprogress instead` for the design simplification.

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

## Notes

- Phase 02 task entries are historical record. Their `Status:` fields reflect the spec README (`done`); consult the git log for commit-level detail.
- T35 is a historical marker only — the SSE-based upload progress design was rolled into T36's XHR-based approach.
- T40 (component tests) and T41 (e2e tests) were dropped per commit `ab06815 chore(tasks): drop T40 (component tests) + T41 (e2e); add T44 + T45 UI priorities`. Their coverage intent is captured by the route tests + the per-component tests written alongside T25-T37.
- T44-T49 are post-spec priority tasks added after the original spec was frozen. They're not in the spec README's "T22 … T43" pointer range — this is the canonical record of what shipped under Phase 02.