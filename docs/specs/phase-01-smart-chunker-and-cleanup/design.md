# Design — Phase 01

## Architecture overview

```mermaid
flowchart LR
  subgraph Upload
    A[Client] -->|multipart/form-data| B[POST /upload or /upload/batch]
    B --> C[services/parser.ts]
    C -->|ParsedDocument<br/>text + blocks[]| D[utils/chunk.ts]
    D -->|Chunk[]<br/>with metadata| E[services/embed.ts<br/>parallel, batched]
    E --> F[services/qdrant.ts<br/>payload indexes]
  end

  subgraph Query
    Q[Client] --> R[POST /search, /search/rag, /chat]
    R --> E2[services/embed.ts]
    E2 --> F2[services/qdrant.ts<br/>filtered query]
    F2 --> R
    R -->|context + history| G[services/openai-api-wrapper.ts]
    G --> R
  end

  subgraph Server
    H[index.ts<br/>graceful shutdown<br/>HEALTHCHECK]
    H -. registers .-> B
    H -. registers .-> R
    H -. registers .-> DL[GET /download]
  end
```

The chunker rewrite changes the `parser → chunk → embed → qdrant` pipeline in `Upload`. The query path is mostly unaffected; chunks now carry richer metadata so `/search` results can include `headingPath` and `pageNumber` in their payload, and `/search` accepts filters.

## Tech stack

| Concern | Choice | Justification |
|---|---|---|
| Tokenizer | `gpt-tokenizer` (MIT, pure JS, cl100k_base) | No native build, MIT, ~30 KB. Sizing is approximate for `nomic-embed-text` but conservative budgets make that fine. |
| Markdown parsing | `unified` + `remark-parse` + `mdast-util-to-string` (MIT) | Real AST, handles edge cases (nested lists, code fences, tables) without us re-implementing them. |
| DOMPurify (UI) | CDN script tag (`cdn.jsdelivr.net`) | Smallest change to the static `public/index.html`. |
| Concurrency | `p-limit` (MIT) for the embed concurrency cap | Tiny, well-tested; cleaner than a hand-rolled semaphore. |
| Testing | `vitest` (already), `fastify.inject` for route tests | Already in devDeps; no new test framework. |

Everything else stays as-is.

## Module / package layout

New and reorganized files (existing files updated in place):

```
src/
  services/
    parser.ts              # dispatcher: parseFile(filePath) -> ParsedDocument (NEW SHAPE)
    parser-markdown.ts     # .md / .markdown → ParsedBlock[]
    parser-pdf.ts          # .pdf → ParsedBlock[] with page numbers
    parser-docx.ts         # .docx → ParsedBlock[]
    parser-text.ts         # .txt → ParsedBlock[] (paragraphs on blank lines)
    parser-types.ts        # ParsedBlock, BlockKind, ParsedDocument
    embed.ts               # parallel + bounded concurrency; retry with backoff (FR-18, FR-19, FR-20)
    qdrant.ts              # payload indexes; client.query; filter support (FR-21–FR-23)
  utils/
    chunk.ts               # public chunkBlocks API + legacy chunkText wrapper (FR-8)
    chunk-tokenizer.ts     # countTokens, splitOnTokens, sentence-boundary alignment
    chunk-structural.ts    # block-list → candidate chunks; structural rules (FR-8–FR-15)
    chunk-semantic.ts      # optional similarity-split pass (FR-16)
    chunk-types.ts         # Chunk, ChunkMetadata, ChunkOptions
    logger.ts              # downloadLog rename; chunk-preview truncation; unused import removed (FR-32, FR-38)
  routes/
    upload.ts              # dedup single/batch; per-file status; bounded parallel embed (FR-24, FR-25)
    download.ts            # path-traversal guard; MIME map (FR-26, FR-27)
    chat.ts                # sessionId validation; bounded history (FR-28, FR-29)
    search.ts              # fileName / fileType filters (FR-30)
  index.ts                 # SIGTERM/SIGINT graceful shutdown (FR-31)
public/
  index.html               # DOMPurify CDN; parallel uploads (FR-33, FR-34)
tsconfig.json              # noImplicitAny: true; noUncheckedIndexedAccess: true (FR-35, FR-36)
Dockerfile                 # HEALTHCHECK; EXPOSE 3001 (FR-40, FR-43)
docker-compose.yml         # Ollama healthcheck; OPENAI_BASE_URL default (FR-41, FR-42)
tests/
  services/
    parser-markdown.test.ts
    parser-pdf.test.ts
    parser-docx.test.ts
    parser-text.test.ts
    embed.test.ts          # expanded: batching, retry, concurrency
    qdrant.test.ts         # NEW: mocked client, payload indexes, query/filter
  utils/
    chunk-tokenizer.test.ts
    chunk-structural.test.ts
    chunk-semantic.test.ts
    chunk.test.ts          # rewritten for new API
  routes/
    upload.test.ts         # NEW: fastify.inject, single + batch + per-file status
    download.test.ts       # NEW: traversal blocked, MIME correct
    chat.test.ts           # NEW: sessionId validation, history cap
    search.test.ts         # NEW: filter passthrough
  e2e/
    upload-and-query.test.ts   # NEW: end-to-end against mocked Ollama + Qdrant
```

The existing `src/utils/chunk.ts` is kept (re-export shim) so anything that imports it gets the new API.

## Data model

```ts
// parser-types.ts
export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'code'
  | 'list'
  | 'table'
  | 'quote'
  | 'page-break'   // PDF page transition marker
  | 'other';

export interface ParsedBlock {
  kind: BlockKind;
  text: string;
  headingPath: string[];       // inherited stack, e.g. ['Chapter 1', 'Section 1.2']
  pageNumber?: number;         // 1-indexed for PDFs
  startOffset: number;         // byte offset in source text
  endOffset: number;
  depth?: number;              // heading depth (1..6) or list nesting level
}

export interface ParsedDocument {
  text: string;                // concatenated plain text (kept for legacy)
  blocks: ParsedBlock[];       // structured view
  fileName: string;
  fileType: string;            // '.pdf' / '.md' / etc.
  totalPages?: number;         // PDFs only
}

// chunk-types.ts
export interface ChunkOptions {
  maxTokens: number;           // default 512
  overlapTokens: number;       // default 64
  minTokens: number;           // default 32
  softMaxTokens?: number;      // default 1.5 * maxTokens; threshold for semantic split
  semanticSplit: boolean;      // default false
  semanticMaxDepth?: number;   // default 2
}

export interface Chunk {
  text: string;
  index: number;
  tokenCount: number;
  blockKind: BlockKind;
  headingPath: string[];
  pageNumber?: number;
  startOffset: number;
  endOffset: number;
}

// DocumentChunk (in services/qdrant.ts) gains these payload fields:
//   blockKind, headingPath, pageNumber, tokenCount
```

## API surface

### Internal

```ts
// services/parser.ts
export async function parseFile(filePath: string): Promise<ParsedDocument>;

// utils/chunk.ts
export function chunkBlocks(blocks: ParsedBlock[], opts: ChunkOptions): Chunk[];

// Back-compat shim — used by tests + any external caller:
export function chunkText(text: string, opts: ChunkOptions & { defaultKind?: BlockKind }): Chunk[];
// Internally: split text into paragraphs (treat as one paragraph-kind block) then chunkBlocks.

// services/embed.ts
export async function embedText(text: string): Promise<number[]>;
export async function embedTexts(texts: string[], opts?: { concurrency?: number }): Promise<number[][]>;
export async function isOllamaAvailable(): Promise<boolean>;

// services/qdrant.ts
export async function initCollection(): Promise<void>;
export async function upsertChunks(chunks: DocumentChunk[]): Promise<void>;
export async function searchChunks(
  queryVector: number[],
  opts: { limit?: number; fileName?: string; fileType?: string; pageNumber?: number }
): Promise<DocumentChunk[]>;
```

### HTTP

| Endpoint | Change |
|---|---|
| `POST /upload` | Unchanged response shape. Internals now use `chunkBlocks` + parallel embed. |
| `POST /upload/batch` | Response shape gains per-file status (FR-25). |
| `GET /search?q&limit&fileName&fileType&expand` | New optional query params (`fileName`, `fileType`, `expand=none\|siblings\|sections`; default `none`). Response items gain `headingPath`, `pageNumber`, `blockKind` (omitted when absent). |
| `GET /search/rag?q&limit&fileName&fileType&expand` | Same as `/search`, plus `expand` controls whether the LLM sees the expanded context. |
| `POST /chat` body | Same body plus optional `expand` field (same semantics). |
| `POST /chat` | Validates `sessionId`. Bounds history. Same response shape. |
| `DELETE /chat/:sessionId` | Unchanged. |
| `GET /download/:filename` | Returns correct MIME; 404 on traversal. |
| `GET /files` | Unchanged. |
| `GET /health` | Unchanged. |

## Key algorithms

### Structured chunking (`chunk-structural.ts`)

```
input: blocks[], maxTokens, overlapTokens, minTokens

accumulator = { blocks: [], tokenCount: 0, headingPath: stack-top }
output = []
overlapBuffer = []     // for carrying overlap into the next chunk

for block in blocks:
  blockTokens = countTokens(block.text)

  // Rule: never split a code block.
  if block.kind === 'code' and blockTokens > maxTokens:
    flush accumulator
    for each code-line group of ≤ maxTokens:
      emit chunk(kind='code', headingPath=block.headingPath, ...)
    continue

  // Rule: keep a list intact.
  if block.kind === 'list' and blockTokens > maxTokens:
    flush accumulator
    for each list-item group of ≤ maxTokens:
      emit chunk(kind='list', ...)
    continue

  if accumulator.tokenCount + blockTokens > maxTokens:
    flush accumulator → output
    overlapBuffer = takeLastSentences(accumulator, overlapTokens)
    reset accumulator with overlapBuffer as seed

  accumulator.add(block)

flush final accumulator → output
merge any trailing chunk with tokenCount < minTokens into previous chunk
return output
```

### Sentence-aligned overlap (`chunk-tokenizer.ts`)

```
function takeLastSentences(text, budgetTokens):
  sentences = splitOnSentences(text)
  out = []
  total = 0
  for s in sentences.reversed():
    if total + countTokens(s) > budgetTokens: break
    out.unshift(s)
    total += countTokens(s)
  return out.join('')

function splitOnSentences(text):
  // regex with negative lookbehind for ASCII letters/digits before '.'
  // handles . ! ? and full-width 。 ! ?
  // collapses abbreviation false-positives via small allowlist
  return text.split(SENTENCE_BOUNDARY_REGEX).filter(nonEmpty)
```

`SENTENCE_BOUNDARY_REGEX` (initial draft; will refine in code):

```js
/(?<![A-Za-z0-9])[.!?](?=\s+)|[。！？](?=\s*)/g
```

An abbreviation allowlist (built into the splitter): `Mr`, `Mrs`, `Ms`, `Dr`, `Prof`, `Sr`, `Jr`, `St`, `vs`, `etc`, `e\.g`, `i\.e`, `U\.S\.A`, `U\.K`, `a\.m`, `p\.m`, decimal numbers (`\d+\.\d+`). For now: a regex that excludes `<letter>+.<lowercase>` (a sentence typically ends `<letter>+.<space><uppercase>` or `<letter>.<newline>`).

### Semantic split (`chunk-semantic.ts`)

```
optional: enabled when opts.semanticSplit === true

for chunk in output where chunk.tokenCount > softMaxTokens:
  windows = slidingWindow(chunk.text, size=maxTokens/2, step=maxTokens/4)
  embeddings = embedTexts(windows.texts, { concurrency: 2 })
  sims = cosSimBetweenAdjacent(embeddings)
  splitAt = argmin(sims)  // lowest similarity → topic shift
  // Split chunk in two at that offset; recurse if either half still > softMaxTokens
  // depth ≤ semanticMaxDepth (default 2)
```

Cost: `~2N / (maxTokens/4)` extra embedding calls per oversized chunk. **On by default** per user decision (OD-2); only chunks exceeding `softMaxTokens` pay this cost.

### Markdown parsing (`parser-markdown.ts`)

```
input: raw markdown text
output: ParsedBlock[]

use unified().use(remarkParse).use(remarkStringify) to get mdast
walk top-level children:
  for each node:
    determine kind (heading / paragraph / code / list / table / blockquote / thematicBreak)
    compute headingPath by tracking current heading stack
    extract text via mdast-util-to-string
    emit ParsedBlock
```

PDF parsing uses `pdf-parse`'s per-page extraction (`pdf(data, { pagerender: customRenderer })` if needed) to get page boundaries; falls back to one block per detected page break (`\f` form feed) if the custom renderer is too painful.

DOCX parsing uses `mammoth.extractRawText({ path })` then a small post-processor that splits on the mammoth output's paragraph boundaries (double newlines in mammoth output). Heading detection: mammoth's `messages` array can be inspected; for this phase we just emit all paragraphs with `kind = 'paragraph'` and the heading stack derived from style hints if available, otherwise `[]`. (Acceptable for FR-5; richer DOCX structure is a future phase.)

TXT parsing: split on `\n\s*\n` → paragraphs.

### Embedding parallelism (`services/embed.ts`)

```ts
import pLimit from 'p-limit';
const limit = pLimit(EMBEDDING_CONCURRENCY);

export async function embedTexts(texts: string[], opts?: { concurrency?: number }): Promise<number[][]> {
  const concurrency = opts?.concurrency ?? parseInt(process.env.EMBEDDING_CONCURRENCY ?? '4', 10);
  const limiter = pLimit(concurrency);
  return Promise.all(texts.map((t) => limiter(() => embedTextWithRetry(t))));
}
```

Retry: `embedTextWithRetry` retries on network errors and 5xx; fails immediately on 4xx.

### Qdrant client migration

`client.search` → `client.query`. `with_payload: true` → `with_payload: { include: ['chunk', 'fileName', ...] }` or simply `with_payload: true` (still accepted but semantically different in newer versions — confirm in implementation).

Payload indexes: created in `initCollection` after the collection exists. Use `client.createPayloadIndex(COLLECTION_NAME, { field_name: 'fileName', field_schema: 'keyword' })` for keyword fields and `integer` for `pageNumber`.

### Path-traversal guard (`routes/download.ts`)

```ts
const safe = path.basename(filename);
const resolved = path.resolve(FILES_DIR, safe);
if (!resolved.startsWith(path.resolve(FILES_DIR) + path.sep)) {
  return reply.callNotFound();
}
```

### Context expansion (`expand` query param)

Implementation lives in `services/qdrant.ts` as `expandHits(originalHits, mode)` and is called from the route handlers after the initial `searchChunks` returns.

```
expandHits(hits, mode='none'):
  if mode === 'none': return hits

  if mode === 'siblings':
    expanded = []
    seen = new Set(hit.id)
    for hit in hits:
      expanded.push(hit)
      for delta in [-2, -1, 1, 2]:
        idx = hit.payload.chunkIndex + delta
        if idx < 0 || idx >= hit.payload.totalChunks: continue
        neighbors = fetchByFilePathAndIndex(hit.payload.filePath, idx)
        for n in neighbors:
          if n.id in seen: continue
          seen.add(n.id)
          expanded.push(n)
          if expanded.length >= 15: return expanded
    return expanded

  if mode === 'sections':
    expanded = [...hits]
    seen = new Set(hits.map(h => h.id))
    for hit in hits:
      if hit.payload.headingPath is empty: continue
      section = fetchByFilePathAndHeadingPath(hit.payload.filePath, hit.payload.headingPath)
      for s in section:
        if s.id in seen: continue
        seen.add(s.id)
        expanded.push(s)
        if expanded.length >= 20: return expanded
    return expanded
```

The two helpers (`fetchByFilePathAndIndex`, `fetchByFilePathAndHeadingPath`) are thin Qdrant filter queries:

```ts
client.query(COLLECTION_NAME, {
  query: null,                         // filter-only fetch
  filter: { must: [
    { key: 'filePath', match: { value: filePath } },
    { key: 'chunkIndex', match: { value: idx } },
  ]},
  limit: 1,
  with_payload: true,
})
```

Failure handling (FR-30f): each helper is wrapped in a try/catch that logs and returns `[]` on error; the original hits are returned unchanged. This means the worst case for any failure is identical to `expand=none`.

### DOMPurify in UI

```html
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
<script>
  const safeHtml = DOMPurify.sanitize(marked.parse(data.answer));
  container.innerHTML = safeHtml;
</script>
```

### Graceful shutdown (`index.ts`)

```ts
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'Shutdown signal received');
  try {
    await fastify.close();
    log.info('Server closed cleanly');
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

## State management

- **Qdrant**: source of truth for chunks and their metadata. Filtered search now possible.
- **In-memory `conversations` Map**: bounded by FR-29 (history cap). Each session's history is a fixed-size deque. Sessions themselves are not garbage-collected — a separate, low-priority follow-up could add an LRU cap on session count. **Out of scope this phase** (logged as future work).
- **File system (`./documents/`)**: source of truth for the original uploaded file. Used by `/download`. Path traversal blocked.
- **No new persistent state.**

## Error handling strategy

| Failure | Behavior |
|---|---|
| Ollama 4xx | Surface as 500 to client. Logged with sanitized payload (truncated chunk text). |
| Ollama 5xx / network | Retried 3x with exponential backoff (250 ms, 500 ms, 1000 ms + jitter). Final failure → 500. |
| Qdrant `ECONNRESET` / 5xx | Single retry. Final failure → 500. (FR scope is limited; full retry/backoff is future work.) |
| Parse error (unsupported file) | 400 with `error` message; original file removed from disk (FR for `/upload`; FR-25 extends this to per-file status in batch). |
| Path traversal on `/download` | 404 (deliberately indistinguishable from "file not found"). |
| Invalid `sessionId` | 400. |
| `expand` secondary fetch fails | Original hits returned; warning logged; request succeeds. |
| Rate / size limits | multipart's existing 50 MB cap; FR-N out of scope to raise it this phase. |

## Testing strategy

- **Unit (per module)**: each parser with hand-crafted inputs; tokenizer boundary cases (Unicode, abbreviations, decimals); structural chunker invariants (no oversize chunks, no split code blocks); semantic-split test with a constructed "topic shift" document.
- **Integration (routes)**: `fastify.inject` for each route. Mock Ollama + Qdrant at the HTTP boundary (using `vi.fn` on `fetch` for Ollama and a fake Qdrant client for the wrapper).
- **E2E**: a single test (`tests/e2e/upload-and-query.test.ts`) that builds the app, injects an upload of a sample markdown doc, then injects a search query and verifies the retrieved chunk carries the expected `headingPath` and that the code block is intact.
- **Coverage thresholds** in `vitest.config.ts`:
  ```ts
  coverage: {
    thresholds: {
      lines: 80,
      functions: 80,
      branches: 75,
      perFile: true,
      'src/utils/chunk-*.ts': { lines: 90 },
      'src/services/parser*.ts': { lines: 90 },
    }
  }
  ```

## Deployment / runtime

### New env vars

| Var | Default | Purpose |
|---|---|---|
| `CHUNK_MAX_TOKENS` | 512 | Token cap per chunk |
| `CHUNK_OVERLAP_TOKENS` | 64 | Overlap in tokens |
| `CHUNK_MIN_TOKENS` | 32 | Minimum chunk size |
| `CHUNK_SEMANTIC_SPLIT` | `true` | Enable similarity-based splitting |
| `EMBEDDING_CONCURRENCY` | 4 | Bounded parallel embeds |
| `CHAT_HISTORY_MAX_TURNS` | 20 | History eviction threshold |
| `LOG_CHUNK_PREVIEW_CHARS` | 200 | Truncation in logged payloads |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Defaulted in compose (was required) |

### Removed env vars

`CHUNK_SIZE`, `CHUNK_OVERLAP` (char-based, replaced by token-based equivalents — see OQ-1).

### Docker

```dockerfile
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

EXPOSE 3001
```

`docker-compose.yml` adds an `ollama` healthcheck:

```yaml
healthcheck:
  # The ollama/ollama image has no curl/wget, so probe via the CLI.
  test: ["CMD-SHELL", "ollama list >/dev/null 2>&1"]
  interval: 5s
  timeout: 5s
  retries: 20
  start_period: 30s
```

and changes the app's `depends_on` to `service_healthy`.

## Security & privacy

- Path traversal guard on `/download` (FR-26).
- LLM output sanitization in UI (FR-33).
- Logged chunk text truncated (FR-32).
- `sessionId` validation (FR-28).
- `OPENAI_API_KEY` only loaded from env (existing behavior).
- Threat model: self-hosted, single-tenant. No multi-user isolation needed this phase.
- PII: log payloads truncate chunk text; document this in README.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `cl100k_base` tokenizer over/under-counts vs `nomic-embed-text`'s BPE | Conservative `maxTokens = 512` (vs 8192 model limit). Document in README. |
| Semantic split adds embedding cost | Off by default; document the flag and cost. |
| Breaking change to chunk payload fields | New fields are additive; old chunks remain queryable. Documented. |
| `unified` + `remark-parse` footprint | ~150 KB on disk; acceptable for a self-hosted tool. |
| DOMPurify CDN dependency | Document; trivially vendorable in a future phase. |
| In-memory chat sessions not GC'd | Per-session history bounded (FR-29); session-count cap deferred, called out as known limitation. |
| Ollama healthcheck race in Docker | `start_period` 30 s + `service_healthy` dependency + app-side retry on first embed. |

## Implementation order

Roughly one task per logical commit. Each task is sized to be reviewable and runs the test suite green before the next starts.

1. **p1-T01** — Add deps (`gpt-tokenizer`, `unified`, `remark-parse`, `mdast-util-to-string`, `p-limit`); `npm install`.
2. **p1-T02** — New parser types + `parser-text.ts` + `parser-markdown.ts` + `parser-docx.ts` + `parser-pdf.ts` + dispatcher rewrite in `services/parser.ts`. Keep `text` field populated for back-compat. Tests for each parser.
3. **p1-T03** — New chunk types + `chunk-tokenizer.ts`. Tests for tokenizer (Unicode, abbreviations, decimals, full-width punctuation).
4. **p1-T04** — New `chunk-structural.ts`. Tests for: code-block preservation, list integrity, sentence-aligned overlap, min-token merge, max-token enforcement.
5. **p1-T05** — New `chunk-semantic.ts`. Test with a topic-shift fixture.
6. **p1-T06** — Rewrite `utils/chunk.ts` as the public API: `chunkBlocks` + legacy `chunkText` shim. Update existing `tests/utils/chunk.test.ts`.
7. **p1-T07** — `services/embed.ts`: parallel embed (`p-limit`), retry with backoff, real `isOllamaAvailable`. Update `tests/services/embed.test.ts`.
8. **p1-T08** — `services/qdrant.ts`: payload indexes in `initCollection`; `searchChunks` filter support; migrate to `client.query`. New `tests/services/qdrant.test.ts`.
9. **p1-T09** — `routes/upload.ts`: extract shared pipeline; per-file batch status; bounded parallel embed; truncated chunk logging.
10. **p1-T10** — `routes/download.ts`: path-traversal guard + MIME map.
11. **p1-T11** — `routes/chat.ts`: sessionId validation; history cap.
12. **p1-T12** — `routes/search.ts`: filter query params; pass to `searchChunks`.
13. **p1-T13** — `index.ts`: SIGTERM/SIGINT graceful shutdown.
14. **p1-T14** — `public/index.html`: DOMPurify CDN; parallel uploads.
15. **p1-T15** — `utils/logger.ts`: rename `donwloadLog` → `downloadLog`; truncate logged chunk text; remove unused `path` import.
16. **p1-T16** — `tsconfig.json`: `noImplicitAny: true`, `noUncheckedIndexedAccess: true`. Fix resulting errors. Remove dead code (`combineChunks`, unused `uuid` import in qdrant).
17. **p1-T17** — Route tests (`tests/routes/*.test.ts`) via `fastify.inject`.
18. **p1-T18** — E2E test (`tests/e2e/upload-and-query.test.ts`).
19. **p1-T19** — `Dockerfile` + `docker-compose.yml`: HEALTHCHECK, Ollama healthcheck, EXPOSE port, env defaults.
20. **p1-T20** — Coverage thresholds in `vitest.config.ts`. Bring up coverage to meet thresholds.
21. **p1-T21** — Final pass: `npm run build`, `npm test`, Docker build verify, README update for new env vars.

## Open decisions

- **OD-1** — Rename `CHUNK_SIZE`/`CHUNK_OVERLAP` → `CHUNK_MAX_TOKENS`/`CHUNK_OVERLAP_TOKENS` (clean break). See OQ-1 in requirements.
- **OD-2** — Semantic split **on by default** (`CHUNK_SEMANTIC_SPLIT=true`).
- **OD-3** — Use `unified`+`remark-parse`.
- **OD-4** — FIFO history eviction.
- **OD-5** — DOMPurify via CDN for now.

## Phase 02 — LLM-driven agent loop (deferred)

Phase 01 ships the static `expand=none|siblings|sections` parameter as a stepping stone. Phase 02 will replace it with an LLM tool-use loop so the model can request more context adaptively.

Concretely (for the Phase 02 spec, not this one):

- Expose tools to the LLM: `get_neighbor_chunks`, `get_section_chunks`, `get_chunk`, `get_document`.
- Loop bounds: max **3 iterations**, tool-result text capped at **10K tokens** per iteration. Both configurable via env.
- Default `expand=auto` (LLM decides); preserve `expand=sections` and `expand=none` as overrides for deterministic / cheap modes.
- Return `toolCalls` in the response for human-transparency in the UI.
- No streaming in Phase 02 (tools + streaming is a separate complexity layer).

Phase 01's `expandHits` helper and the Qdrant filter queries built in p1-T12 are designed to be the implementation primitives the agent loop will call — no rework needed in Phase 02.