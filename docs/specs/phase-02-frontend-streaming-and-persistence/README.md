# Phase 02 — Frontend, Streaming, and Persistence

**Status:** done
**Started:** 2026-06-30
**Done:** 2026-07-01

## Isolation
- **Branch:** `main` (medium-large feature — multi-day; spec folder only, no dedicated worktree)
- **Worktree:** n/a

## Pointers
- **Tasks:** T22 … T49 (T44-T49 are post-spec priority follow-ups) in [`TASKS.md`](./TASKS.md)
- **Spec:** [`requirements.md`](./requirements.md), [`design.md`](./design.md)
- **Design source:** [`mockups/dockhoj-chat-v2.html`](./mockups/dockhoj-chat-v2.html), [`mockups/dockhoj-upload-v2.html`](./mockups/dockhoj-upload-v2.html) (canonical visual contract)
- **Related specs:** Phase 01 (`../phase-01-smart-chunker-and-cleanup/`)

## Why isolated (or not)
Adds a build step (Vite + Preact), a server-side persistence layer (`better-sqlite3` on a Docker volume), and three new HTTP surfaces (SSE chat stream, session CRUD, upload progress). Spans UI, server routing, persistence, and Docker — too broad for one atomic change, narrow enough to land on `main` across ~20 reviewable commits. No dedicated worktree: review is sequential and the spec is the contract.

## Scope summary
- **Routing convention:** every API under `/api/*`, every UI page under `/{page}`. This is a hard cut — Phase 02 moves the existing `/chat`, `/search`, `/search/rag`, `/upload`, `/download/:filename` endpoints to `/api/chat`, `/api/search`, `/api/search/rag`, `/api/upload`, `/api/download/:filename`. `/health` moves to `/api/health` and the `Dockerfile` `HEALTHCHECK` line is updated to match. The SPA shell renders `/chat` and `/upload`; everything else falls through to the SPA's client router.
- **Replace the single-page `public/index.html`** with a Vite + Preact SPA. Two routes: `/chat`, `/upload`. Visual contract enforced from `mockups/dockhoj-chat-v2.html` and `mockups/dockhoj-upload-v2.html`.
- **Multi-turn conversations:** server keeps the existing `sessionId`-keyed history but persists it in SQLite so it survives restarts. Sessions are listed in a sidebar, switched between, and auto-titled from the first message.
- **Real token-by-token streaming** from the OpenAI-compatible chat API to the browser via Server-Sent Events on `POST /api/chat/stream`. SSE protocol carries typed events (`meta`, `sources`, `token`, `done`, `error`). Aborts cleanly on disconnect.
- **Single-server-executable deployment:** one Fastify process serves the SPA static (`web/dist/`), all `/api/*` routes, and the SPA fallback. No nginx, no separate static-file server. The production build is `dist/` + `web/dist/`, run by `node dist/index.js` inside the existing app container.
- **Document upload progress** surfaces as a live queue with per-file row status (mirroring `mockups/dockhoj-upload-v2.html`). Existing `POST /api/upload` endpoint stays; progress is reported via chunked completion events on the new `GET /api/upload/progress` SSE endpoint.

## Out of scope (this phase)

- **LLM tool-use agent loop (Phase 03).** Phase 01's `expand=none|siblings|sections` stays; the LLM agent loop (tools, `expand=auto`, max 3 iterations, 10K-token tool-result cap) is the entire Phase 03 spec.
- Multi-user / authn / authz. Single-tenant, single-user self-hosted.
- Hierarchical / parent-child chunk storage.
- Cross-encoder re-ranking.
- Document deletion endpoint (deferred again; see Phase 01).
- Voice input, push notifications, mobile native shell.
- Migrating the existing in-memory `conversations` Map to a backend store — we go straight to SQLite; the Map is removed.

## Decisions deferred to review
See `requirements.md` → "Open questions" and `design.md` → "Open decisions". Please flag any you want changed before implementation starts.