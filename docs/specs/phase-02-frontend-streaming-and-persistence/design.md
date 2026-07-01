# Design — Phase 02

## Architecture overview

```mermaid
flowchart LR
  subgraph Browser
    UI[Preact SPA<br/>web/dist]
    UI -->|fetch JSON| API[API client<br/>services/api.ts]
    UI -->|fetch+ReadableStream| SSE[SSE client<br/>services/stream.ts]
  end

  subgraph Server (single Fastify process)
    SPA[server/spa.ts<br/>static + fallback]
    Routes[/ routes /]
    API -->|GET /api/sessions| Sessions[services/conversations.ts]
    API -->|POST /api/upload| Upload[routes/upload.ts]
    SSE -->|POST /api/chat/stream| ChatStream[services/stream-chat.ts]
    SSE -->|GET /api/upload/progress| UploadBus[EventEmitter]
    Upload -->|publish| UploadBus
    ChatStream -->|persist| Sessions
    ChatStream -->|embed| Embed[services/embed.ts]
    ChatStream -->|retrieve| Qdrant[services/qdrant.ts]
    ChatStream -->|stream tokens| OpenAI[services/openai-api-wrapper.ts]
    Sessions --> SQLite[(SQLite<br/>conversations.db)]
    SPA -->|serves| Static[web/dist/<br/>Vite output]
  end

  OpenAI -.stream.-> LLM[OpenAI-compatible API]
  Embed -.embed.-> Ollama[Ollama :11434]
  Qdrant -.query.-> QdrantDB[(Qdrant)]
```

Three new surfaces:

1. **SPA shell** — Vite-built Preact bundle served as static from Fastify. SPA fallback for non-API GETs.
2. **SQLite store** — single-file DB on a Docker volume. Persists conversations and messages.
3. **SSE channels** — `/api/chat/stream` and `/api/upload/progress`. Server-to-client only; uses the `fetch` + `ReadableStream` pattern on the browser (POST with a body, which native `EventSource` doesn't support).

Routing discipline: **API under `/api/*`, pages under `/{page}`.** Fastify's static plugin handles literal file lookups first; the SPA fallback handler returns `index.html` for any non-`/api/*` GET that didn't match a static file; `/api/*` returns JSON 404 on unknown paths. The two namespaces can never collide.

## Tech stack

| Concern | Choice | Justification |
|---|---|---|
| SPA framework | **Preact 10** + `@preact/preset-vite` | React API, ~3 KB runtime. Same ergonomics as React, ~15× smaller bundle. |
| Routing | **wouter-preact** | Tiny (~3 KB) routing library. History mode + server SPA fallback. |
| SSE parser (client) | Native `fetch` + `ReadableStream` | Native `EventSource` doesn't support POST with body. Hand-rolled parser, ~50 LOC. |
| Build tool | **Vite 5** | Fast dev loop, ESM-native, mature. |
| SQLite | **better-sqlite3** (MIT) | Synchronous, fast, single-file DB. The de-facto Node choice. |
| Migrations | **Hand-rolled** — `db/migrations/NNN_*.sql`, applied on startup in a single `db.exec(...)` inside a transaction | No lib; ~50 LOC. Tracks applied migrations in a `_migrations` table. |
| Streaming client SDK | Native `openai` SDK with `stream: true` (already in `package.json` from Phase 01) | We don't add a new SDK. |
| Tests | **vitest** (server, already), **@testing-library/preact** + **happy-dom** (new) | `@testing-library/preact` is the Preact equivalent of `@testing-library/react`. |
| Markdown / sanitization | **marked + DOMPurify** (moved from CDN to npm dep in `web/package.json`) | Kills a runtime third-party dep. |
| Single-server-executable | **One Fastify process** running `dist/index.js` inside the `app` container | Default per FR-55. No nginx, no separate static server. |

`wouter-preact`, `@preact/preset-vite`, `better-sqlite3`, `marked`, `DOMPurify`, `@testing-library/preact` are all MIT.

## Module / package layout

```
repo/
  src/                                     # server (existing, expanded)
    db/
      index.ts                             # better-sqlite3 singleton + WAL pragma
      migrations/
        001_init.sql                       # conversations + messages tables + indexes
        002_*.sql                          # future migrations
      migrate.ts                           # apply pending migrations on startup
    services/
      conversations.ts                     # ConversationStore (CRUD, message append)
      stream-chat.ts                       # SSE handler: build prompt, open OpenAI stream, emit events
      openai-api-wrapper.ts                # ADDS streamChatCompletionRaw(messages) → AsyncIterable<{text}>
    routes/
      api-sessions.ts                      # /api/sessions, /api/sessions/:id, /api/sessions/:id/messages
      chat.ts                              # /api/chat (non-stream) + /api/chat/stream (SSE)
      search.ts                            # /api/search, /api/search/rag
      upload.ts                            # /api/upload (existing, publishes to uploadBus)
      upload-progress.ts                   # /api/upload/progress (SSE)
      download.ts                          # /api/download/:filename
      api-status.ts                        # /api/status → {chunks, ollamaAvailable}
      api-health.ts                        # /api/health (moved from /health)
    server/
      spa.ts                               # serves web/dist + SPA fallback handler
    index.ts                               # registers routes; calls migrate() before listen()
  web/                                     # NEW — Vite + Preact SPA
    index.html
    src/
      main.tsx                             # entry; mounts <App />
      App.tsx                              # route table; top-level layout
      routes/
        Chat.tsx                           # /chat — full chat surface
        Upload.tsx                         # /upload — dropzone + queue
      components/
        TopBar.tsx
        Sidebar.tsx                        # session list + new-session
        Bubble.tsx                         # user / assistant bubble; streaming caret; source chips
        Composer.tsx                       # textarea + send; autosize; Enter/Shift+Enter
        SourceDrawer.tsx                   # inline drawer for source chip clicks
        Dropzone.tsx
        QueueRow.tsx
        icons/                             # minimal inline SVG icons
      services/
        api.ts                             # typed fetch wrappers
        stream.ts                          # POST + ReadableStream SSE parser
        sessions.ts                        # session CRUD against /api/sessions
        markdown.ts                        # marked + DOMPurify; sanitize before render
        status.ts                          # GET /api/status
      styles/
        tokens.css                         # CSS custom properties (color, type, space, motion)
        base.css                           # reset + body + selection
        animations.css                     # aurora, grain, grid-overlay, pulse, rise, caret, blink
        app.css                            # page-specific styles
      types.d.ts                           # shared types (Conversation, Message, Source)
    vite.config.ts                         # @preact/preset-vite + singlefile plugin
    tsconfig.json
    package.json
  docs/specs/phase-02-frontend-streaming-and-persistence/
    README.md
    requirements.md
    design.md
    mockups/
      dockhoj-chat-v2.html
      dockhoj-upload-v2.html
  tests/
    db/
      conversations.test.ts                # NEW
      migrate.test.ts                      # NEW
    services/
      stream-chat.test.ts                  # NEW — SSE event sequence, abort on disconnect
    routes/
      api-sessions.test.ts                 # NEW
      chat-stream.test.ts                  # NEW — fastify.inject + simulated disconnect
      upload-progress.test.ts              # NEW
      api-health.test.ts                   # NEW
      spa-fallback.test.ts                 # NEW — page routes 200, /api/* 404 JSON
    components/                            # NEW (under web/, scanned by vitest workspaces)
      Composer.test.tsx
      Sidebar.test.tsx
      Bubble.test.tsx
      QueueRow.test.tsx
      SourceDrawer.test.tsx
    e2e/
      upload-and-query.test.ts             # EXTENDED — uses /api/* paths
  Dockerfile                               # UPDATED — npm run build:web, copy web/dist, HEALTHCHECK on /api/health
  docker-compose.yml                       # UPDATED — conversations_data volume, app depends_on ollama service_healthy (unchanged)
  package.json                             # UPDATED — build:web, dev scripts
  vitest.config.ts                         # UPDATED — include web/src, add coverage thresholds for new code
```

The `public/` directory is removed in Phase 02. Its replacement is `web/dist/` (built output) plus `web/src/` (source). No static HTML in `public/`; everything ships through the SPA.

## Data model

```sql
-- src/db/migrations/001_init.sql

CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,                  -- UUIDv4, fits ^[A-Za-z0-9_-]{1,64}$
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,                  -- UUIDv4
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  sources TEXT,                          -- JSON array of Source, nullable (only on assistant)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_created_at
  ON messages (conversation_id, created_at);

PRAGMA journal_mode = WAL;             -- set at connection open; WAL allows concurrent readers during writes
PRAGMA foreign_keys = ON;
```

```ts
// src/services/conversations.ts
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;     // ISO-8601
  updatedAt: string;
  messageCount: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];    // assistant only
  createdAt: string;
}

export interface Source {
  fileName: string;
  filePath: string;
  chunk: string;
  pageNumber?: number;
  headingPath?: string[];
  score: number;
}
```

```ts
// src/services/stream-chat.ts (event types)
export type StreamEvent =
  | { type: 'meta'; sessionId: string; userMessageId: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'token'; text: string }
  | { type: 'done'; messageId: string; totalTokens?: number }
  | { type: 'error'; message: string };
```

## API surface

### Internal

```ts
// src/services/conversations.ts
export class ConversationStore {
  constructor(private readonly db: Database) {}

  list(): Conversation[];
  get(id: string): Conversation | null;
  create(): Conversation;
  rename(id: string, title: string): Conversation | null;
  delete(id: string): boolean;

  appendUserMessage(conversationId: string, content: string): Message;
  appendAssistantMessage(
    conversationId: string,
    content: string,
    sources: Source[]
  ): Message;
  listMessages(conversationId: string): Message[];
  autoTitle(conversationId: string): void;     // first 60 chars of first user msg
  bumpUpdatedAt(conversationId: string): void; // called on every append
}

// src/services/stream-chat.ts
export async function* streamChatCompletion(
  params: {
    question: string;
    sessionId: string;
    contextChunks: DocumentChunk[];
    conversationHistory: ChatMessage[];
  },
  signal: AbortSignal
): AsyncGenerator<StreamEvent>;

// src/services/openai-api-wrapper.ts (additive)
export async function* streamChatCompletionRaw(
  messages: ChatMessage[],
  signal: AbortSignal
): AsyncGenerator<{ text: string }>;
```

### HTTP

All paths under `/api/*`. All UI paths under `/{page}`. The SPA fallback serves `index.html` for any non-`/api/*` GET that didn't match a static file.

| Endpoint | Method | Purpose | Notes |
|---|---|---|---|
| `/api/sessions` | `POST` | Create a session | `{q?, ...}` → `{id, title, createdAt}` (FR-8). |
| `/api/sessions` | `GET` | List sessions | Most-recent first (FR-9). |
| `/api/sessions/:id` | `GET` | Get one | 404 if missing (FR-10). |
| `/api/sessions/:id` | `PATCH` | Rename | `{title: string}` (FR-12). |
| `/api/sessions/:id` | `DELETE` | Remove | 204 (FR-13). |
| `/api/sessions/:id/messages` | `GET` | List messages | Chronological (FR-11). |
| `/api/chat` | `POST` | Non-streaming chat | Body: `{q, sessionId?, limit?, expand?}` — kept for back-compat / scripts. |
| `/api/chat/stream` | `POST` | SSE chat | Body: `{q, sessionId?, limit?, expand?}` (FR-17). |
| `/api/upload` | `POST` | Upload | Unchanged from Phase 01. |
| `/api/upload/progress` | `GET` | SSE upload progress | `event: file` / `event: idle` (FR-26). |
| `/api/search` | `GET` | Raw search | Unchanged from Phase 01. |
| `/api/search/rag` | `GET` | RAG search | Unchanged from Phase 01. |
| `/api/download/:filename` | `GET` | Download | Path-traversal guard from Phase 01 (FR-26 of Phase 01). |
| `/api/status` | `GET` | `{chunks: number, ollamaAvailable: bool}` | Topbar chrome (FR-39, FR-43). |
| `/api/health` | `GET` | `{status: "ok", ollama: bool}` | Moved from `/health`; `Dockerfile` HEALTHCHECK updated. |
| `/chat` | `GET` | UI page | SPA serves `index.html`; client router renders `<Chat />`. |
| `/upload` | `GET` | UI page | SPA serves `index.html`; client router renders `<Upload />`. |
| `/` | `GET` | Redirect | 302 to `/chat`. |
| `/*` | `GET` | SPA fallback | Returns `web/dist/index.html` for non-`/api/*` paths only. |

## Key algorithms

### SQLite migration runner

```ts
// src/db/migrate.ts
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

export function migrate(db: Database, dir: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((r: { id: number }) => r.id)
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  db.transaction(() => {
    for (const f of files) {
      const id = parseInt(f.split('_')[0], 10);
      if (applied.has(id)) continue;
      const sql = readFileSync(path.join(dir, f), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(id);
    }
  })();
}
```

### SSE chat handler

```ts
// src/routes/chat.ts (POST /api/chat/stream)
import { streamChatCompletion } from '../services/stream-chat.js';
import { ConversationStore } from '../services/conversations.js';

fastify.post('/api/chat/stream', async (request, reply) => {
  const { q, sessionId: providedSid, limit, expand } = request.body as ChatBody;
  if (!q) return reply.status(400).send({ error: 'Question "q" is required' });

  const store = new ConversationStore(db);
  const sid = providedSid ?? store.create().id;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sid)) {
    return reply.status(400).send({ error: 'Invalid sessionId' });
  }

  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
  reply.raw.flushHeaders();

  const ac = new AbortController();
  reply.raw.on('close', () => ac.abort());

  const userMessageId = uuidv4();
  let fullText = '';

  try {
    store.appendUserMessage(sid, q);
    writeEvent(reply.raw, 'meta', { sessionId: sid, userMessageId });

    const queryVector = await embedText(q);
    const baseResults = await searchChunks(queryVector, { limit: limit ?? 5 });
    const results = await expandHits(baseResults, { mode: expandMode(expand) });

    const sources = results.map(mapHitForStream);
    writeEvent(reply.raw, 'sources', sources);

    const history = store.listMessages(sid).slice(-CHAT_HISTORY_MAX_TURNS * 2);

    for await (const ev of streamChatCompletion(
      { question: q, sessionId: sid, contextChunks: results.map(mapChunkForPrompt), conversationHistory: history },
      ac.signal
    )) {
      if (ev.type === 'token') {
        const cleaned = stripThinkTags(ev.text);
        fullText += cleaned;
        writeEvent(reply.raw, 'token', { text: cleaned });
      } else if (ev.type === 'error') {
        writeEvent(reply.raw, 'error', { message: ev.message });
      }
    }
    if (ac.signal.aborted) return; // client gone — do not persist or send done
    const assistantMessageId = store
      .appendAssistantMessage(sid, fullText, sources).id;
    writeEvent(reply.raw, 'done', { messageId: assistantMessageId });
  } catch (err) {
    if (ac.signal.aborted) return;
    log.error({ err }, 'Chat stream error');
    writeEvent(reply.raw, 'error', { message: 'Chat failed' });
  } finally {
    reply.raw.end();
  }
});

function writeEvent(stream: NodeJS.WritableStream, event: string, data: unknown) {
  stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
```

### OpenAI streaming wrapper (additive)

```ts
// src/services/openai-api-wrapper.ts (additive)
export async function* streamChatCompletionRaw(
  messages: ChatMessage[],
  signal: AbortSignal
): AsyncGenerator<{ text: string }> {
  const stream = await openai.chat.completions.create(
    {
      model: LLM_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 1000,
      stream: true,
    },
    { signal }
  );
  for await (const chunk of stream) {
    const text = chunk.choices?.[0]?.delta?.content ?? '';
    if (text) yield { text };
  }
}
```

### SSE parser (client, fetch + ReadableStream)

```ts
// web/src/services/stream.ts
export type StreamEvent =
  | { type: 'meta'; sessionId: string; userMessageId: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'token'; text: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string };

export function openChatStream(
  body: { q: string; sessionId?: string; limit?: number; expand?: string },
  handlers: {
    onEvent: (ev: StreamEvent) => void;
    onError?: (e: unknown) => void;
  }
): { close: () => void } {
  const ac = new AbortController();
  fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: ac.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        handlers.onError?.(new Error(`HTTP ${res.status}`));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          let type = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            handlers.onEvent({ type, ...JSON.parse(data) } as StreamEvent);
          } catch {
            // malformed line — skip per FR tolerance
          }
        }
      }
    })
    .catch((e) => {
      if (e?.name !== 'AbortError') handlers.onError?.(e);
    });
  return { close: () => ac.abort() };
}
```

### SPA fallback (`server/spa.ts`)

```ts
// src/server/spa.ts
import fastifyStatic from '@fastify/static';
import path from 'node:path';

export async function mountSpa(fastify: FastifyInstance, webDistPath: string) {
  await fastify.register(fastifyStatic, {
    root: webDistPath,
    prefix: '/',
    decorateReply: false,
    // Don't auto-redirect missing files; we want the notFoundHandler to decide.
    fallthrough: true,
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    reply.sendFile('index.html');
  });
}
```

The order is important: the static plugin is registered first (handles literal files), then `setNotFoundHandler` is the catch-all. The `startsWith('/api/')` check ensures API 404s return JSON, not HTML.

### Upload progress event bus

```ts
// src/routes/upload.ts (existing; adds publish)
import { EventEmitter } from 'node:events';

export const uploadBus = new EventEmitter();

fastify.post('/api/upload', async (request, reply) => {
  // ... existing pipeline ...
  uploadBus.emit('file', { fileName, status: 'queued', progress: 0 });
  // ... after each chunk embedded:
  uploadBus.emit('file', { fileName, status: 'embedding', progress: pct });
  // ... after all chunks upserted:
  uploadBus.emit('file', { fileName, status: 'ready', progress: 100, chunksIndexed });
});

// src/routes/upload-progress.ts
fastify.get('/api/upload/progress', async (request, reply) => {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.flushHeaders();

  const send = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const onFile = (data: unknown) => send('file', data);
  uploadBus.on('file', onFile);
  send('idle', {}); // initial state

  reply.raw.on('close', () => uploadBus.off('file', onFile));
});
```

## State management

- **SQLite** is the source of truth for `conversations` and `messages`. WAL mode allows the upload progress handler to read while an upload is writing.
- **In-process `EventEmitter` for upload progress.** No need for Redis / external pub-sub at single-instance scale.
- **Browser:** URL hash (`#session=<id>`) is the canonical pointer to the current session. `localStorage` (key `dockhoj.sessionId`) is a fallback for reload-without-hash. Sessions are listed from `GET /api/sessions` on app mount.
- **No client-side state store** (no Redux, no Zustand). Component-local state and `useState`/`useEffect` are enough for this surface.

## Error handling strategy

| Failure | Behavior |
|---|---|
| OpenAI 4xx | SSE `event: error` with sanitized message; stream closes; nothing persisted. |
| OpenAI 5xx / network | SSE `event: error`; stream closes; nothing persisted. |
| Client disconnect mid-stream | Server detects via `reply.raw.on('close')`, aborts the OpenAI stream via `AbortController`; partial assistant message is **discarded** (FR-21, FR-22). |
| Embedding 404 (Ollama) | SSE `event: error` with `"embedding unavailable"`; stream closes. |
| SQLite write error | Logged; SSE `event: error`; stream closes. The user's typed message is preserved client-side; retry on next send. |
| Session not found | 404 from `/api/sessions/:id`. Client clears stale `localStorage` and creates a new session. |
| Vite build failure | `npm run build:web` exits non-zero; CI/operator notices. |
| `/api/*` GET to unknown route | JSON 404 from `setNotFoundHandler` (NOT the SPA `index.html`). |
| `/{page}` GET to unknown page | SPA `index.html` from `setNotFoundHandler`; client router renders a "not found" view. |

## Testing strategy

- **Server unit:** `ConversationStore` CRUD with a real `better-sqlite3` `:memory:` DB. `migrate()` applies `001_init.sql` and is idempotent.
- **Server route (SSE):** `fastify.inject` with a stubbed `openai.chat.completions.create({ stream: true })` returning a fake async iterator. Assert the SSE event sequence: `meta, sources, token*N, done`. Disconnect simulation: close the request mid-stream, assert `AbortController.abort()` was called.
- **Server route (upload progress):** subscribe to `/api/upload/progress`, fire a `POST /api/upload`, assert `event: file` events arrive with the right statuses.
- **Server route (SPA fallback):** `fastify.inject({ method: 'GET', url: '/chat' })` returns 200 with `Content-Type: text/html`; `GET /api/does-not-exist` returns 404 with `Content-Type: application/json`.
- **Client component:** `@testing-library/preact` + `happy-dom`. Render `<Composer />`, fire `keydown` events, assert callbacks. Render `<Sidebar />` with mocked session list, assert clicks invoke the right handler. Render `<Bubble />` and assert streamed tokens append to `innerText`.
- **Client SSE:** `stream.ts` is exercised by component tests; the parser is unit-tested with hand-crafted SSE chunks (single event, multiple events, malformed line).
- **E2E:** `tests/e2e/upload-and-query.test.ts` (extended from Phase 01): open the SPA, upload a sample markdown, send a chat message, assert streamed tokens arrive.
- **Coverage:** project line coverage ≥ 80% (Phase 01 threshold). New code targets: `src/db/`, `src/services/conversations.ts`, `src/services/stream-chat.ts`, `web/src/components/`, `web/src/services/` — each ≥ 80% line.

## Deployment / runtime

### New env vars

| Var | Default | Purpose |
|---|---|---|
| `SQLITE_PATH` | `/app/data/conversations.db` (Docker) or `./data/conversations.db` (host) | SQLite DB file path. |
| `WEB_DIST` | `web/dist` | Path to the built SPA bundle (relative to project root or absolute). |
| `PORT` | `3001` | Unchanged. |

### Removed env vars

None.

### Docker

```dockerfile
# Dockerfile (UPDATED)

# ... existing build steps ...

# Build the SPA
RUN npm run build:web

# Copy the built bundle into the image (already inside /app/web/dist from the build step)
# No extra COPY needed if the build writes to /app/web/dist (the root-relative default).

# ... existing runtime steps ...

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1
```

```yaml
# docker-compose.yml (UPDATED)
services:
  app:
    # ... existing ...
    volumes:
      - ./documents:/app/documents
      - conversations_data:/app/data    # NEW — SQLite lives here
    environment:
      - SQLITE_PATH=/app/data/conversations.db

volumes:
  qdrant_data:
  conversations_data:                   # NEW
```

`Dockerfile.ollama` is unchanged from commit `3d2ace7`.

### Single-server-executable deployment

The production runtime is **one Fastify process** running `node dist/index.js` inside the app container. It serves:

- Static SPA assets from `web/dist/` (handled by `@fastify/static`)
- All `/api/*` routes (handled by the registered route handlers)
- The SPA fallback `index.html` for any non-`/api/*` GET that didn't match a static file
- The healthcheck at `/api/health`

No nginx. No separate static-file server. No bundling complexity beyond Vite (client) + tsc (server). One process, one container, one image.

If a true single-binary executable becomes a hard requirement later (e.g. for distribution outside Docker), `bun build --compile` is the lowest-friction path; see OD-8.

## Security & privacy

- Source code chunks persisted to SQLite contain document text (already in Qdrant). No new data exposure.
- LLM API key only in env (existing behavior).
- SSE responses are HTTP/1.1 with no buffering. The `X-Accel-Buffering: no` header disables proxy buffering.
- DOMPurify sanitization of assistant markdown (Phase 01 FR-33, retained).
- `/api/*` namespace isolation: API 404s return JSON, never the SPA shell — prevents accidental HTML responses to API clients.
- Threat model unchanged: self-hosted, single-tenant.
- No new user-supplied code paths: the sessionId is UUIDv4 server-generated, so the existing regex validation now rejects any non-UUID the client somehow tries to forge.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `better-sqlite3` native build fails in Docker | Use `node:22-alpine` (already in use) and ensure `python3 make g++` are present during `npm install`. CI runs the build to catch drift. |
| Single-instance SQLite write contention during parallel uploads | `WAL` journal mode + the upload route serializes per-file DB writes (the chat write is independent). |
| SSE drop on idle keep-alive proxies | Send a `:\n\n` comment heartbeat every 15s while a stream is open. |
| Vite bundle bloat | Pin Preact + `vite-plugin-singlefile`; enforce < 300 KB gzipped in CI (a build step that asserts the size). |
| Auto-title races (two sends in flight for a brand-new session) | Second send wins; titles settle on first message anyway. Simpler is fine for this phase. |
| DOMPurify CDN dropped in favor of npm dep | Add to `web/package.json`; tests cover the new import path. |
| Path-migration breaks existing curl/scripts | Document the new paths in the README; the existing endpoints simply stop existing (404). No back-compat aliasing. |

## Implementation order

Roughly one task per logical commit. Each task sized to be reviewable, runs the test suite green, and ends in a committable state.

1. **T22** — Add deps: `better-sqlite3`, `wouter-preact`, `@preact/preset-vite`, `vite`, `vite-plugin-singlefile`, `@testing-library/preact`, `happy-dom`, `marked`, `dompurify` (moved from CDN to npm). Verify lockfile.
2. **T23** — Create `web/` scaffold: `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/vite.config.ts`, `web/tsconfig.json`, `web/package.json`. Vite dev server runs on `npm --prefix web run dev` (port 5173). Build outputs to `web/dist/`.
3. **T24** — Extract design tokens: copy `:root` from `mockups/dockhoj-chat-v2.html` into `web/src/styles/tokens.css`. Add `base.css` (reset, body, selection). Add `animations.css` (aurora, grain, grid, pulse, rise, caret, blink).
4. **T25** — Build static UI scaffold (no API yet): `TopBar`, `Sidebar` (with seed sessions), `Bubble`, `Composer` (no-op), `Dropzone`, `QueueRow` (static). Render both routes with sample data; verify visual contract at all design-spec viewports. Add responsive styles.
5. **T26** — Add `src/db/`, `001_init.sql`, `migrate.ts`. Wire `migrate()` into `index.ts` startup before `initCollection()`.
6. **T27** — Implement `services/conversations.ts` (CRUD + message append + auto-title + listMessages). Unit tests against `:memory:` DB.
7. **T28** — Add `routes/api-sessions.ts` (POST/GET/PATCH/DELETE + `:id/messages`). Route tests via `fastify.inject`.
8. **T29** — **Path migration cut:** move every existing API endpoint from its old path to `/api/*`. Update `routes/chat.ts`, `routes/search.ts`, `routes/upload.ts`, `routes/download.ts`, add `routes/api-health.ts` for `/api/health`. Update `routes/upload.ts` to publish to `uploadBus`. Update all callers (existing tests, README) to use the new paths.
9. **T30** — Wire SPA to `/api/sessions`: `web/src/services/sessions.ts` (typed fetch), `Sidebar.tsx` (real list), click-to-switch.
10. **T31** — Add `streamChatCompletionRaw` to `services/openai-api-wrapper.ts` (additive).
11. **T32** — Add `services/stream-chat.ts` orchestrating: embed → search → prompt → stream → emit SSE. Stub-friendly.
12. **T33** — Add `routes/chat.ts` `POST /api/chat/stream` SSE handler. Route tests assert event sequence + abort on disconnect.
13. **T34** — Client SSE: `web/src/services/stream.ts`. `Bubble.tsx` renders streamed tokens live. `Composer.tsx` sends via `openChatStream`. Test SSE parser.
14. **T35** — Add `routes/api-status.ts` (`GET /api/status` → `{chunks, ollamaAvailable}`). `TopBar.tsx` reads it on mount.
15. **T36** — Add upload progress event bus: `uploadBus` in `routes/upload.ts`. Subscribe in new `/api/upload/progress` SSE handler (`routes/upload-progress.ts`). Route test.
16. **T37** — Wire `QueueRow.tsx` to live `/api/upload/progress` updates. `Dropzone.tsx` calls `POST /api/upload` and the row's progress/state updates from the SSE stream.
17. **T38** — Add `SourceDrawer.tsx` (inline drawer) and `Bubble.tsx` source-chip click handler.
18. **T39** — Add `server/spa.ts` (mount `web/dist/` + SPA fallback). Update `Dockerfile` to run `npm run build:web` and update `HEALTHCHECK` to `/api/health`. Update `docker-compose.yml` with `conversations_data` volume.
19. **T40** — Update root `package.json` scripts: `build:web`, `dev` (orchestrate server + Vite via `concurrently`), `start`, `test` (vitest workspaces for `web/`).
20. **T41** — Component tests (`@testing-library/preact`): `Composer`, `Sidebar`, `Bubble`, `QueueRow`, `SourceDrawer`.
21. **T42** — E2E test extension: real Docker stack, upload sample, send chat, assert streamed tokens arrive. Use new `/api/*` paths.
22. **T43** — Coverage thresholds in `vitest.config.ts` updated to include the new code paths at ≥ 80% lines. README update: new env vars, new `/api/*` paths, Docker compose volume, `build:web` script.

## Open decisions

- **OD-1** — Preact (recommended) vs React proper. See OQ-1 in requirements.
- **OD-2** — `better-sqlite3` (recommended) vs `node:sqlite` (Node 22+ built-in, experimental). See OQ-2 in requirements.
- **OD-3** — SPA fallback is catch-all (`setNotFoundHandler` for non-`/api/*` GETs). See OQ-3 in requirements.
- **OD-4** — Keep sessionId regex `^[A-Za-z0-9_-]{1,64}$` (UUIDv4 fits). See OQ-4 in requirements.
- **OD-5** — Auto-title: first 60 chars of the first user message, ellipsised. See OQ-5 in requirements.
- **OD-6** — Source-chip opens an inline drawer. See OQ-6 in requirements.
- **OD-7** — Topbar chunk count is live from `/api/status`. See OQ-7 in requirements.
- **OD-8** — "Single-server-executable" interpretation: default = single Node process serving everything (FR-55). Optional future path = `bun build --compile` or `pkg` for a true single binary. See OQ-8.

## Phase 03 (deferred) — LLM tool-use agent loop

The Phase 01 spec listed the agent loop as "Phase 02 — LLM-driven agent loop". It's now Phase 03 because Phase 02 absorbed the frontend / streaming / persistence work. The Phase 03 spec (not written yet) covers:

- Tools exposed to the LLM: `get_neighbor_chunks`, `get_section_chunks`, `get_chunk`, `get_document`.
- Loop bounds: max **3 iterations**, tool-result text capped at **10K tokens** per iteration. Both configurable via env.
- Default `expand=auto` (LLM decides); preserve `expand=sections` and `expand=none` as overrides for deterministic / cheap modes.
- `toolCalls` field in the assistant message (already plumbed via the `sources` array on the message).
- No streaming in Phase 03 (tools + streaming is a separate complexity layer; deferred).

Phase 02's `services/stream-chat.ts` and the SSE event envelope are designed to carry tool-call events when Phase 03 adds them — the `StreamEvent` type can grow a `tool_call` variant without breaking the existing handlers.