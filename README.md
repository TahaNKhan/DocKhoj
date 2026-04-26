# 📄 DocKhoj

**Khoj** (کھوج) — means "search" in Urdu, from the Persian root meaning "to find."

DocKhoj is a self-hosted document indexing and RAG search tool. It helps you upload your documents and then query them using natural language — getting answers backed by your own files, with citations.

## Tech Stack

- **Ollama** (in Docker) for embeddings
- **Qdrant** for vector storage
- **OpenAI-compatible API** (OpenAI, MiniMax, any compatible provider) for chat answers
- **Fastify** web server

## Quick Start (Docker)

```bash
# 1. Copy env and configure
cp .env.example .env
nano .env   # Add OPENAI_API_KEY

# 2. Spin up everything (Ollama + Qdrant + App)
docker compose up -d

# 3. Wait for Ollama to download the embedding model (~2-5 min first time)
docker compose logs -f ollama

# 4. Check app is running
open http://localhost:3001
```

**First start:** Ollama downloads the `nomic-embed-text` model on first boot (takes a few minutes).

---

## Manual Setup (without Docker)

### Prerequisites
- **Node.js 20+**
- **Docker** (for Qdrant and Ollama)

### Run without Docker

```bash
npm install
cp .env.example .env
# Edit .env with your API keys

# Start Qdrant and Ollama
docker compose up -d qdrant ollama

# Run the app
npm run dev
```

Open http://localhost:3001

---

## Features

- 📤 Upload PDFs, DOCX, TXT, MD files (drag & drop)
- 🔍 Vector similarity search across all documents
- 💬 RAG-powered Q&A with citations
- 💾 Conversation history
- 🌐 Simple web UI

---

## API Endpoints

### Upload a file
```bash
curl -X POST http://localhost:3001/upload \
  -F "file=@document.pdf"
```

### Vector search
```bash
curl "http://localhost:3001/search?q=what%20is%20the%20project%20about&limit=5"
```

### RAG search (returns answer + sources)
```bash
curl "http://localhost:3001/search/rag?q=what%20is%20the%20project%20about"
```

### Chat with context
```bash
curl -X POST http://localhost:3001/chat \
  -H "Content-Type: application/json" \
  -d '{"q": "what was discussed in the meeting?"}'
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
| `PORT` | `3000` | Server port |
| `CHUNK_SIZE` | `500` | Characters per chunk |
| `CHUNK_OVERLAP` | `50` | Overlap between chunks |

---

## Tech Stack (detailed)

- **Fastify** - Fast web framework
- **Qdrant** - Vector database
- **Ollama** - Local embedding inference (in Docker)
- **OpenAI-compatible API** - Chat model for RAG answers
- **pdf-parse** - PDF text extraction
- **mammoth** - DOCX text extraction
- **TypeScript** - Type safety
- **Docker Compose** - One-command startup

---

## Ports

| Service | Port | Description |
|---------|------|-------------|
| App | 3001 | Web UI + API |
| Qdrant | 6333 | Vector DB (REST) |
| Qdrant | 6334 | Vector DB (gRPC) |
| Ollama | 11434 | Embedding API (Docker internal) |

## License

MIT