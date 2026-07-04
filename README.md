# 📄 DocKhoj

**Khoj** (کھوج) — means "search" in Urdu, from the Persian root meaning "to find."

DocKhoj is a self-hosted document indexing and RAG search tool. It helps you upload your documents and then query them using natural language — getting answers backed by your own files, with citations.

## Tech Stack

- **Ollama** (in Docker) for embeddings (`nomic-embed-text`, swappable via `EMBEDDING_MODEL`)
- **Qdrant** for vector storage with payload indexes and filtered search
- **OpenAI-compatible API** (OpenAI, MiniMax, any compatible provider) for chat answers
- **Fastify** web server with multipart uploads and graceful shutdown
- **gpt-tokenizer** (cl100k_base) for token-aware chunk sizing
- **unified + remark-parse + remark-gfm** for markdown structure
- **Preact + Vite** SPA (`web/`) — markdown-rendered chat bubbles, live streaming, upload progress
- **better-sqlite3** for conversations + message persistence (with WAL + FK)

## Quick Start (Docker)

```bash
# 1. Copy env and configure
cp .env.example .env
# Edit .env — set OPENAI_API_KEY (others have sensible defaults)

# 2. Spin up everything (Ollama + Qdrant + App)
docker compose up -d

# 3. First build pulls the embedding model into the DocKhoj ollama image
#    (~2–5 min, ~274 MB). Subsequent builds reuse the image cache.
docker compose build ollama       # only needed once / after dependency changes
docker compose logs -f ollama    # to watch the first pull

# 4. Check app is healthy
curl http://localhost:3001/api/health
# {"status":"ok","ollama":true}

# 5. Open the UI
open http://localhost:3001
```

**First start:** the `nomic-embed-text` model is **baked into the `ollama` service image** at build time (see `Dockerfile.ollama`). You don't need to run `ollama pull` manually — `docker compose up` is enough.

---

## Manual Setup (without Docker)

### Prerequisites
- **Node.js 20+**
- **Docker** (for Qdrant and Ollama)

### Run without Docker

```bash
npm install
npm --prefix web install
cp .env.example .env
# Edit .env with your OPENAI_API_KEY

# Start Qdrant and Ollama
docker compose up -d qdrant ollama

# Run the app (server + web SPA in parallel)
npm run dev
```

Open http://localhost:3001

---

## Features

- 📤 Upload PDFs, DOCX, TXT, MD files (drag & drop, multi-file batch with per-file status)
- 🗑️ List and **delete** indexed documents — Qdrant filter-delete + SQLite row + on-disk file all cleaned up
- 🔍 Vector similarity search with **filters** (`fileName`, `fileType`) and **structured metadata** on every chunk (`headingPath`, `pageNumber`, `blockKind`)
- 🧱 Token-aware, **structurally-aware chunker** — never splits a code fence or a single list item, carries heading paths through to citations
- ✂️ Optional **semantic splitting** for long uniform sections (on by default; uses extra embedding calls)
- 🧩 Server-side **context expansion** with `expand=siblings` or `expand=sections` on `/api/search`, `/api/search/rag`, and `/api/chat`
- 🤖 **Agentic RAG** with `expand=auto` — the LLM gets four retrieval tools (neighbors, sections, single chunk, document metadata) and may call them in a bounded loop (default 3 iterations, 10K-token per-iteration tool-result cap) before answering
- 💬 RAG-powered Q&A with citations, **streaming tokens** via SSE, plus `tool_call` / `tool_result` events for the agentic path
- 🧠 Markdown rendering in assistant bubbles (sanitized via DOMPurify — XSS-safe per FR-33)
- 🪛 Tool chips below each assistant bubble — click to expand and audit the agent's reasoning
- 💾 Persistent conversations in SQLite — survives container restarts; tool calls persist on each assistant message
- 🛡️ Path-traversal-safe download endpoint with correct MIME types
- ⚡ Bounded-parallel embedding via `p-limit` and exponential-backoff retry
- 🧯 Graceful shutdown on SIGTERM/SIGINT

---

## API Endpoints

All routes are under `/api/*`. Page routes (`/chat`, `/upload`) are served by the SPA.

### Sessions & messages

```bash
# List all conversations (most-recently-updated first)
curl http://localhost:3001/api/sessions

# Create a new conversation
curl -X POST http://localhost:3001/api/sessions

# Fetch one conversation
curl http://localhost:3001/api/sessions/<id>

# Fetch all messages in a conversation
curl http://localhost:3001/api/sessions/<id>/messages

# Rename a conversation (sets title_source = 'user' so LLM can't overwrite)
curl -X PATCH http://localhost:3001/api/sessions/<id> \
  -H 'Content-Type: application/json' \
  -d '{"title":"My Project Plan"}'

# Delete a conversation (cascades to messages via FK)
curl -X DELETE http://localhost:3001/api/sessions/<id>
```

`sessionId` is constrained to `^[A-Za-z0-9_-]{1,64}$`.

### Chat

```bash
# Non-streaming chat with a session (returns full answer + title)
curl -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"q":"what was discussed in the meeting?","sessionId":"<id>","expand":"sections"}'

# Streaming chat (SSE — events: meta, sources, token*, tool_call*, tool_result*, done, title)
curl -N -X POST http://localhost:3001/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"q":"hello","sessionId":"<id>"}'
```

The `tool_call*` and `tool_result*` events fire only when `expand=auto` (the agentic path). On the non-agentic path (Phase 02 behavior), only `meta / sources / token / done / title` events are emitted.

### Search

```bash
# Vector search
curl "http://localhost:3001/api/search?q=what%20is%20the%20project%20about&limit=5&fileName=notes.md"

# RAG search (returns answer + sources)
curl "http://localhost:3001/api/search/rag?q=what%20is%20the%20project%20about&expand=sections"

# expand=none | siblings | sections   (default: none)
```

`expand=sections` returns all chunks in the same `headingPath`; `expand=siblings` returns neighbors ±2.

### Upload

```bash
# Upload a single file
curl -X POST http://localhost:3001/api/upload -F "file=@document.pdf"
# -> {"success":true,"fileName":"document.pdf","chunksIndexed":42,"fileId":"..."}

# Live upload progress (SSE — events: file, idle)
curl -N http://localhost:3001/api/upload/progress
```

### Download

```bash
curl -OJ "http://localhost:3001/api/download/<internal-filename>"
```

Returns the file with the correct `Content-Type` based on extension. Path traversal attempts return 404.

### Status & health

```bash
# Health check (used by Docker HEALTHCHECK)
curl http://localhost:3001/api/health
# -> {"status":"ok","ollama":true}

# Live chunk count + Ollama reachability (for the TopBar status indicator)
curl http://localhost:3001/api/status
# -> {"chunks":298,"ollamaAvailable":true,"documents":3}
```

### Documents

```bash
# List all indexed documents, most-recent first
curl http://localhost:3001/api/documents
# -> {"documents":[{"fileId":"abc-123","fileName":"notes.md","fileType":"md","bytes":4096,"chunkCount":17,"uploadedAt":"2026-07-02 09:00:00"}, ...]}

# Delete a document (removes Qdrant points, the on-disk file, and the SQLite row)
curl -X DELETE http://localhost:3001/api/documents/<fileId>
# -> {"success":true,"chunksDeleted":17,"fileId":"abc-123"}
```

### SPA pages

```bash
curl -sI http://localhost:3001/chat     # 200 text/html
curl -sI http://localhost:3001/upload   # 200 text/html
```

Any other non-`/api/*` path falls back to the SPA's `index.html`.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | **Required** | Your OpenAI-compatible API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API base URL |
| `LLM_MODEL` | `gpt-4o` | Chat model name |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama server URL (Docker network) |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `QDRANT_URL` | `http://qdrant:6333` | Qdrant server URL |
| `QDRANT_COLLECTION` | `documents` | Qdrant collection name |
| `VECTOR_SIZE` | `768` | Embedding vector dimension |
| `PORT` | `3001` | Server port |
| `SQLITE_PATH` | `/app/data/conversations.db` | SQLite file for conversations + messages. Inside the container the path is bind-mounted to `${DOCKHOJ_HOME}/db` (default `~/.dockhoj/db`) so it survives container rebuilds. |
| `WEB_DIST` | `<repo>/web/dist` | Path to the built SPA. The server falls back to this directory when serving non-`/api/*` routes. |
| `CHUNK_MAX_TOKENS` | `512` | Max tokens per chunk |
| `CHUNK_OVERLAP_TOKENS` | `64` | Overlap tokens at chunk boundaries |
| `CHUNK_MIN_TOKENS` | `32` | Trailing chunks smaller than this are merged |
| `CHUNK_SEMANTIC_SPLIT` | `true` | Split oversized chunks at topic-shift boundaries |
| `EMBEDDING_CONCURRENCY` | `4` | Max parallel embed calls |
| `CHAT_HISTORY_MAX_TURNS` | `20` | Conversation history cap per session |
| `LOG_CHUNK_PREVIEW_CHARS` | `200` | Truncate logged chunk text to this many characters |
| `MAX_AGENT_ITERATIONS` | `10` | Agent loop's LLM-call cap (p3-T17 raised the default from 3 to 10 — the previous cap caused the LLM to get cut off mid-investigation on questions that needed more than 3 retrieval rounds). The LLM is told the cap in the system prompt and gets a per-iteration `[System reminder]` user message naming the current iteration + remaining count, with escalating urgency as it approaches the limit. |
| `TOOL_RESULT_TOKEN_CAP` | `10000` | Per-iteration cap on total tool-result tokens (cl100k_base). Lower = smaller LLM context window per iteration. |

---

## Authentication

Phase 04 adds user accounts. Every `/api/*` endpoint **except `/api/auth/*` and `/api/health`** requires a valid session — without one, the server returns `401 {"error":"Authentication required"}`.

### First-run setup

On a fresh install the `users` table is empty. Visit `http://localhost:3001/register`, pick a username and password, and the very first account is created with `role = 'admin'`. Subsequent signups require an invite from the admin (`Admin → Invites → New invite` in the SPA, or `POST /api/admin/invites` over curl).

### Auth endpoints

```bash
# Register (first user only — returns 403 once any user exists)
curl -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"taha","password":"correct-horse-battery-staple!"}'
# -> {"id":"...","username":"taha","role":"admin"} + Set-Cookie: dockhoj_sid=...

# Login (returns 401 with the same message on bad username OR bad password — no enumeration)
curl -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"taha","password":"..."}'

# Whoami (cookie required — 401 if not signed in)
curl http://localhost:3001/api/auth/me

# Logout (idempotent — clears the cookie + deletes the server-side session row)
curl -X POST http://localhost:3001/api/auth/logout

# Accept an invite
curl -X POST http://localhost:3001/api/auth/invite/accept \
  -H 'Content-Type: application/json' \
  -d '{"token":"<invite-token>","username":"alex","password":"..."}'

# Admin only — list users, create / revoke invites
curl http://localhost:3001/api/admin/users
curl -X POST http://localhost:3001/api/admin/invites \
  -H 'Content-Type: application/json' \
  -d '{"expiresInDays":7}'
curl -X DELETE http://localhost:3001/api/admin/invites/<id>
```

The full endpoint table (including `/api/admin/users/:id/password` for admin password resets) lives in the Phase 04 spec: [`requirements.md`](./docs/specs/phase-04-user-accounts-and-private-knowledge/requirements.md), [`design.md`](./docs/specs/phase-04-user-accounts-and-private-knowledge/design.md).

### Cookie & session

The session id rides in an HttpOnly, SameSite=Lax cookie named `dockhoj_sid`. Sessions expire **30 days after the last request** — every authenticated request pushes the expiry forward. To revoke a session, delete the row server-side (logout, admin "force logout", user deletion, or the expiry sweep).

> **Production note — serve over HTTPS.** The cookie's `Secure` flag is **off** when `NODE_ENV=development` and **on** when `NODE_ENV=production`. Browsers will not send a `Secure` cookie over plain HTTP, so a production deployment without HTTPS will fail to keep users logged in. Phase 04 does not terminate TLS itself — front the app with a reverse proxy (Caddy, nginx, Traefik, …) that handles certificates and forwards to the app on `localhost:3001` over plain HTTP internally.

### Passwords

- 12+ characters, at least one non-alphanumeric.
- Hashed with Node's stdlib `crypto.scrypt` (no native build).
- The hash string is prefixed `scrypt$…` so a future argon2id swap is a single-file verify-path change with no DB migration.

The ownership / visibility model — every search, chat, and agent-tool query is filtered to "documents this user can see" — is documented in [`design.md`](./docs/specs/phase-04-user-accounts-and-private-knowledge/design.md) §"Visibility filter".

---

## Breaking changes from Phase 01 → Phase 02

The Phase 02 cutover moved every JSON API under `/api/*`. If you're upgrading from a Phase 01 deployment, your existing scripts and integrations need the following path updates:

| Phase 01 path | Phase 02 path |
|---|---|
| `POST /chat` | `POST /api/chat` |
| `POST /api/chat/stream` | unchanged (added in Phase 02) |
| `GET /search` | `GET /api/search` |
| `GET /search/rag` | `GET /api/search/rag` |
| `POST /upload` | `POST /api/upload` |
| `GET /upload/progress` | `GET /api/upload/progress` (added in Phase 02) |
| `GET /download/:filename` | `GET /api/download/:filename` |
| `GET /health` | `GET /api/health` |
| `GET /status` | `GET /api/status` (added in Phase 02) |
| n/a | `POST /api/sessions` (added in Phase 02) |
| n/a | `GET /api/sessions` (added in Phase 02) |
| n/a | `GET /api/sessions/:id/messages` (added in Phase 02) |
| n/a | `PATCH /api/sessions/:id` (added in Phase 02) |
| n/a | `DELETE /api/sessions/:id` (added in Phase 02) |

The old paths return 404 JSON (no redirects). The SPA itself runs under `/` (and serves `/chat` and `/upload`), so the UI URL is unchanged.

Phase 02 also adds SQLite-backed conversations + messages — the previous in-memory `Map`-backed conversations no longer survive container restarts.

## Behavior changes from Phase 02 → Phase 03

Phase 03 is **mostly additive** (no existing endpoint paths change), but two behavior changes are worth knowing about:

1. **Default expand mode is now `auto`.** Every `/api/chat/stream` request now runs the agentic loop unless the caller explicitly passes `expand=none`, `expand=siblings`, or `expand=sections`. The Phase 02 default was `none`. The SPA's toolbar reflects the same change: the new expand-mode chip defaults to `Auto`. If your existing scripts / automations were relying on the non-agentic fast path, pass `"expand":"none"` explicitly to keep Phase 02 behavior.
2. **Tool calls are streamed live + persisted.** The `/api/chat/stream` SSE envelope gains two new event types (`tool_call`, `tool_result`) on the agentic path. Persisted assistant messages gain a `tool_calls` column (JSON-encoded array). The wire shape for the original events (`meta`, `sources`, `token`, `done`, `title`, `error`) is unchanged.

The non-streaming `/api/chat` endpoint keeps its `expand=none` default and Phase 02 behavior. Phase 03 doesn't run the agent loop on `/api/chat` — only on `/api/chat/stream`.

---

## Behavior changes from Phase 03 → Phase 04

Phase 04 is **mostly additive** (no existing endpoint paths change), but the request surface and the ownership model shift substantially. Read this section carefully if you're upgrading from a Phase 03 deployment.

1. **All `/api/*` endpoints now require auth** — except `/api/health` (the Docker HEALTHCHECK depends on it) and `/api/auth/*` (login, logout, register, me, status, invite/accept). Every other route returns `401 {"error":"Authentication required"}` without a valid `dockhoj_sid` cookie. This includes `/api/status` — the TopBar status indicator now only shows after the user signs in.
2. **Documents are per-user.** `GET /api/documents` returns only files the requester owns plus files in the shared bucket (legacy `owner_id = NULL` rows). A user cannot list, download, or delete another user's private file — the server returns `404` for all three (same opaque code whether the file is missing or the caller lacks permission, so existence is not leaked).
3. **Search and chat are scoped.** Every Qdrant query — `/api/search`, `/api/search/rag`, `/api/chat`, `/api/chat/stream`, and all four agent-loop tools (`get_neighbor_chunks`, `get_section_chunks`, `get_chunk`, `get_document`) — carries a `buildVisibilityFilter(viewerId)` clause. The LLM cannot reason its way around the filter: `get_document` with a foreign `fileId` returns "not found".
4. **Pre-Phase-04 documents become shared; pre-Phase-04 conversations are dropped on migration.** Existing documents get `owner_id = NULL, visibility = 'public'` (visible to every logged-in user; deletable by any logged-in user). Existing conversations and messages are **deleted** at migration time — a clean slate was the user's explicit choice for the new ownership model, so `SELECT COUNT(*) FROM sessions` returns `0` immediately after the upgrade. See [`design.md`](./docs/specs/phase-04-user-accounts-and-private-knowledge/design.md) §"API surface" for the modified-endpoint table.

The SPA gains `/login`, `/register`, `/register/:token`, and (for admins) `/admin/users` + `/admin/invites`. Any visit to `/chat`, `/upload`, or `/admin/*` while unauthenticated redirects to `/login?next=<original-path>`. The first visitor to a fresh install hits `/register`, creates the admin account, and is logged in.

---

## Docker Compose

The stack consists of three services (`app`, `ollama`, `qdrant`). Two bind-mounted host directories persist data across `docker compose down` and container rebuilds, both rooted under `$DOCKHOJ_HOME` (default `~/.dockhoj/`):

| Host path                              | Container mount       | Holds                |
| -------------------------------------- | --------------------- | -------------------- |
| `${DOCKHOJ_HOME}/db`                   | `/app/data` (app)     | SQLite (`conversations.db`, WAL, SHM) |
| `${DOCKHOJ_HOME}/qdrant`               | `/qdrant/storage`     | Qdrant vector store |

`./restart.sh` exports `DOCKHOJ_HOME` and creates the directories on first run; `migrate_state` lifts data from older layouts (`./qdrant_data/`, in-container `/app/data`) so existing users keep their sessions + embeddings. Ollama keeps the embedding model baked into its image — no host mount, no shadowing.

Point `DOCKHOJ_HOME` elsewhere if you run multiple DocKhoj stacks on the same host, or want to back the data up on a separate disk:

```bash
DOCKHOJ_HOME=/path/to/backup ./restart.sh
```

Bind-mount the source if you're iterating on the code:

```bash
# Live-reload the Fastify server
docker compose up app ollama qdrant
# In another terminal:
npm run dev:server    # tsx watch the server in your host node

# Live-reload the SPA
npm --prefix web run dev    # Vite serves on :5173
```

---

## NPM Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run server + SPA together (concurrently) |
| `npm run dev:server` | Server only (tsx watch) |
| `npm run dev:web` | SPA only (Vite) |
| `npm run build` | `build:server` + `build:web` |
| `npm run build:server` | TypeScript build + asset copy |
| `npm run build:web` | Install SPA deps + Vite single-file build → `web/dist/` |
| `npm start` | Run the compiled server (`dist/index.js`) |
| `npm test` | Run all vitest projects |
| `npm run coverage` | Run vitest with v8 coverage (fails if thresholds unmet) |
| `npm run setup-ollama` | `ollama pull nomic-embed-text` (local install only) |

---

## Chunker design

The chunker is the load-bearing component for retrieval quality. It is:

1. **Token-aware** (not char-aware). Sizes are in tokens via `gpt-tokenizer` (cl100k_base). The default budget of 512 is well below the embedding model's 8192-token context.
2. **Structurally-aware**. Parses markdown into blocks (headings, paragraphs, code, lists, tables, blockquotes). PDF page boundaries are preserved with `pageNumber` metadata. DOCX preserves paragraph and heading-style structure.
3. **Block-integrity preserving**. Never splits a fenced code block. Never splits a single list item's continuation lines. Lists and code blocks are sized down to fit when they exceed the cap.
4. **Sentence-aligned overlap**. Overlap text is selected via sentence-boundary alignment on both ends (handles abbreviations, decimals, full-width punctuation).
5. **Metadata-rich**. Each chunk carries `blockKind`, `headingPath`, `pageNumber`, `tokenCount`, `startOffset`, `endOffset` so citations can point to the right section and page.
6. **Semantic-split fallback** (on by default). For chunks exceeding `softMaxTokens` (1.5 × max), embeds sliding windows of the chunk and splits at the lowest cosine similarity between adjacent windows. Recursion depth is capped at 2 to bound the embedding-call cost.

To swap embedding models (e.g. `bge-m3`, `mxbai-embed-large`, or any Ollama model), change `EMBEDDING_MODEL` and `VECTOR_SIZE`. `VECTOR_SIZE` must match the model's output dimension, otherwise the Qdrant collection is recreated on first run with the wrong size — back up your `qdrant_data/` volume before changing.

---

## Project layout

```
src/
  parser/                Structured parsers (markdown AST, PDF page-aware, DOCX, text)
  services/
    parser.ts            Dispatcher → returns ParsedDocument { text, blocks[], ... }
    embed.ts             Ollama embeddings with retry + parallel + real isOllamaAvailable
    qdrant.ts            client.query, payload indexes, filter builder, expandHits,
                         deleteByFilePath, fetchByFilePathAnd*
    openai-api-wrapper.ts  Chat completions + RAG context preparation +
                         streamChatCompletionWithTools
    conversations.ts     SQLite-backed ConversationStore (CRUD, title-source
                         rules, toolCalls persistence)
    stream-chat.ts       Embed → search → prompt → token orchestrator (FR-17..20)
    agent-tools.ts       The four LLM-callable retrieval tools + AGENT_TOOLS
    agent-loop.ts        Bounded agent loop generator
                         (sources / token / tool_call / tool_result / done)
    document-store.ts    SQLite-backed DocumentStore CRUD (p3-T01)
    title-generator.ts   LLM-driven title generation with fallback (FR-14, FR-15)
  db/
    index.ts             better-sqlite3 singleton (WAL + FK), lazy dir create
    migrate.ts           Hand-rolled migration runner (idempotent, sorted NNN_*.sql)
    migrations/          001_init.sql, 002_title_source.sql,
                         003_documents.sql, 004_tool_calls.sql
  utils/
    chunk-types.ts       ChunkOptions, Chunk, env defaults
    chunk-tokenizer.ts   countTokens + sentence splitter + abbreviation handling
    chunk-structural.ts  Block-aware chunker (the main one)
    chunk-semantic.ts    Cosine-similarity-based semantic split
    chunk.ts             Public API: chunkBlocks / chunkText / chunkMarkdown
    text-token-budget.ts countTokens + truncateToTokenBudget (Phase 03 —
                         used by the agent loop's per-iteration tool-result cap)
    logger.ts            Pino with per-component child loggers + truncateForLog
  routes/
    api-health.ts        GET  /api/health
    api-status.ts        GET  /api/status (chunks + ollamaAvailable + documents)
    api-sessions.ts      POST/GET/PATCH/DELETE on /api/sessions[/:id[/messages]]
    api-documents.ts     GET /api/documents, DELETE /api/documents/:fileId
    chat.ts              POST /api/chat (non-stream)
    chat-stream.ts       POST /api/chat/stream (SSE; dispatches to agent loop
                         when expand=auto; falls back to non-agentic on
                         tools_not_supported)
    upload.ts            POST /api/upload (publishes events to uploadBus)
    upload-progress.ts   GET  /api/upload/progress (SSE)
    search.ts            /api/search and /api/search/rag (filters + expand)
    download.ts          Path-traversal-safe file serving with MIME map
  server/
    spa.ts               @fastify/static mount + SPA fallback for non-/api/*
  index.ts               Fastify app + graceful SIGTERM/SIGINT shutdown

web/
  src/
    components/          Bubble, Composer, DocumentsList, Dropzone, QueueRow,
                         Sidebar, SourceDrawer, TopBar, ToolUseLine
    routes/              Chat.tsx (expand-mode toggle), Upload.tsx
    services/            documents.ts, sessions.ts, status.ts, stream.ts,
                         markdown.ts, upload.ts
    styles/              tokens.css, base.css, animations.css, bubble.css, ...
    types.d.ts           SPA-side type mirrors (ToolCallRecord)
  tests/                 vitest (happy-dom) — Bubble, Chat (expand-mode),
                         DocumentsList, Sidebar, SourceDrawer, services (markdown, sessions, status,
                         stream, upload)

tests/
  db/                    SQLite singleton + migration runner
  parser/                Markdown + text parser tests
  services/              Embed, Qdrant, parser dispatcher, OpenAI wrapper,
                         stream-chat, title-generator, conversations,
                         document-store, agent-tools, agent-loop,
                         text-token-budget
  routes/                fastify.inject-based route tests (api-health,
                         api-documents, api-sessions, api-status, chat,
                         chat-stream, download, search, spa-fallback, upload)
  e2e/                   parse-and-chunk end-to-end
  test-helpers.ts        Shared mocks
```

---

## Tech Stack (detailed)

- **Fastify** - Fast web framework with multipart uploads
- **Qdrant** - Vector DB with payload indexes on `fileName`, `filePath`, `fileType`, `pageNumber`
- **Ollama** - Local embedding inference (in Docker)
- **OpenAI-compatible API** - Chat model for RAG answers
- **gpt-tokenizer** - cl100k_base for token-aware chunk sizing
- **unified / remark-parse / remark-gfm** - Markdown AST parsing
- **p-limit** - Bounded parallel embeddings
- **mammoth** - DOCX text extraction
- **pdf-parse** - PDF text extraction with per-page boundaries
- **better-sqlite3** - Conversations + messages (WAL + FK cascade)
- **pino** - Structured logging
- **TypeScript** - Strict mode (`noImplicitAny`, `noUncheckedIndexedAccess`)
- **Preact + Vite + vite-plugin-singlefile** - SPA bundled into a single `index.html`
- **DOMPurify + marked** - Sanitized markdown rendering in chat bubbles
- **Docker Compose** - One-command startup with Ollama healthcheck
- **Vitest** - Test framework with coverage thresholds

---

## Ports

| Service | Port | Description |
|---------|------|-------------|
| App | 3001 | Web UI + API + healthcheck |
| Qdrant | 6333 | Vector DB (REST) |
| Qdrant | 6334 | Vector DB (gRPC) |
| Ollama | 11434 | Embedding API (Docker internal) |

## License

MIT