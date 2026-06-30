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

## Quick Start (Docker)

```bash
# 1. Copy env and configure
cp .env.example .env
# Edit .env — set OPENAI_API_KEY (others have sensible defaults)

# 2. Spin up everything (Ollama + Qdrant + App)
docker compose up -d

# 3. Wait for Ollama to download the embedding model (~2-5 min first time)
docker compose logs -f ollama

# 4. Check app is healthy
curl http://localhost:3001/health
# {"status":"ok","ollama":true}

# 5. Open the UI
open http://localhost:3001
```

**First start:** Ollama downloads the `nomic-embed-text` model on first boot. The app waits for Ollama's healthcheck before starting, so it will be patient.

---

## Manual Setup (without Docker)

### Prerequisites
- **Node.js 20+**
- **Docker** (for Qdrant and Ollama)

### Run without Docker

```bash
npm install
cp .env.example .env
# Edit .env with your OPENAI_API_KEY

# Start Qdrant and Ollama
docker compose up -d qdrant ollama

# Run the app
npm run dev
```

Open http://localhost:3001

---

## Features

- 📤 Upload PDFs, DOCX, TXT, MD files (drag & drop, multi-file batch with per-file status)
- 🔍 Vector similarity search with **filters** (`fileName`, `fileType`) and **structured metadata** on every chunk (`headingPath`, `pageNumber`, `blockKind`)
- 🧱 Token-aware, **structurally-aware chunker** — never splits a code fence or a single list item, carries heading paths through to citations
- ✂️ Optional **semantic splitting** for long uniform sections (on by default; uses extra embedding calls)
- 🧩 Server-side **context expansion** with `expand=siblings` or `expand=sections` on `/search`, `/search/rag`, and `/chat`
- 💬 RAG-powered Q&A with citations
- 🛡️ Path-traversal-safe download endpoint with correct MIME types
- 🧹 DOMPurify-sanitized LLM responses (XSS-safe)
- ⚡ Bounded-parallel embedding via `p-limit` and exponential-backoff retry
- 🧯 Graceful shutdown on SIGTERM/SIGINT
- 📊 Per-file batch status; failed uploads don't block the rest

---

## API Endpoints

### Upload a file
```bash
curl -X POST http://localhost:3001/upload \
  -F "file=@document.pdf"
```

Response:
```json
{ "success": true, "fileName": "document.pdf", "chunksIndexed": 42, "fileId": "..." }
```

### Vector search
```bash
curl "http://localhost:3001/search?q=what%20is%20the%20project%20about&limit=5&fileName=notes.md"
```

Each result includes `text`, `fileName`, `fileType`, `filePath`, `chunkIndex`, `headingPath[]`, `pageNumber`, `blockKind`, and `score`.

### Vector search with context expansion
```bash
curl "http://localhost:3001/search?q=section%203.2&expand=sections"
# expand=none | siblings | sections   (default: none)
```

`expand=sections` returns all chunks in the same `headingPath`; `expand=siblings` returns neighbors ±2.

### RAG search (returns answer + sources)
```bash
curl "http://localhost:3001/search/rag?q=what%20is%20the%20project%20about&expand=sections"
```

### Chat with context
```bash
curl -X POST http://localhost:3001/chat \
  -H "Content-Type: application/json" \
  -d '{"q": "what was discussed in the meeting?", "sessionId": "optional-id", "expand": "sections"}'
```

### Download an uploaded file
```bash
curl -OJ "http://localhost:3001/download/<internal-filename>"
```
Returns the file with the correct `Content-Type` based on extension. Path traversal attempts return 404.

### Health check
```bash
curl http://localhost:3001/health
# {"status":"ok","ollama":true}
```

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
| `CHUNK_MAX_TOKENS` | `512` | Max tokens per chunk |
| `CHUNK_OVERLAP_TOKENS` | `64` | Overlap tokens at chunk boundaries |
| `CHUNK_MIN_TOKENS` | `32` | Trailing chunks smaller than this are merged |
| `CHUNK_SEMANTIC_SPLIT` | `true` | Split oversized chunks at topic-shift boundaries |
| `EMBEDDING_CONCURRENCY` | `4` | Max parallel embed calls |
| `CHAT_HISTORY_MAX_TURNS` | `20` | Conversation history cap per session |
| `LOG_CHUNK_PREVIEW_CHARS` | `200` | Truncate logged chunk text to this many characters |

`sessionId` is constrained to `^[A-Za-z0-9_-]{1,64}$` and defaults to `"default"`.

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
    qdrant.ts            client.query, payload indexes, filter builder, expandHits
    openai-api-wrapper.ts  Chat completions + RAG context preparation
  utils/
    chunk-types.ts       ChunkOptions, Chunk, env defaults
    chunk-tokenizer.ts   countTokens + sentence splitter + abbreviation handling
    chunk-structural.ts  Block-aware chunker (the main one)
    chunk-semantic.ts    Cosine-similarity-based semantic split
    chunk.ts             Public API: chunkBlocks / chunkText / chunkMarkdown
    logger.ts            Pino with per-component child loggers + truncateForLog
  routes/
    upload.ts            Single + batch upload with per-file status and parallel embed
    download.ts          Path-traversal-safe file serving with MIME map
    search.ts            Search + RAG with fileName/fileType filters and expand mode
    chat.ts              Session-validated chat with bounded history and expand mode
  index.ts               Fastify app + graceful SIGTERM/SIGINT shutdown

tests/
  parser/                Markdown + text parser tests
  services/              Embed, Qdrant, parser dispatcher, OpenAI wrapper
  utils/                  Tokenizer, structural chunker, semantic-split, public chunk API
  routes/                fastify.inject-based route tests
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
- **pino** - Structured logging
- **TypeScript** - Strict mode (`noImplicitAny`, `noUncheckedIndexedAccess`)
- **Docker Compose** - One-command startup with Ollama healthcheck
- **Vitest** - Test framework with coverage thresholds
- **DOMPurify** - LLM response sanitization (CDN)

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