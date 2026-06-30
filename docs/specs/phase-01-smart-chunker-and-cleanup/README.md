# Phase 01 — Smart Chunker & Cleanup

**Status:** done
**Started:** 2026-06-29
**Done:** 2026-06-30

## Isolation
- **Branch:** `main` (medium feature — 1–3 days; spec folder only, no dedicated worktree)
- **Worktree:** n/a

## Pointers
- **Tasks:** T1.x … T18.x in `TASKS.md`
- **PR / merge commit:** _pending_
- **Related specs:** none (first phase)

## Why isolated (or not)
Spans the parser, chunker, embedding, Qdrant, route, UI, Docker, and TS-config layers — too broad for a one-file fix, narrow enough to land on `main` in atomic commits. The chunker rewrite is the load-bearing change; the cleanup items are batched in because they share review context and several share files with the chunker work.

## Scope summary
- Replace the char-based, structure-blind chunker with a token-aware, block-aware splitter driven by a structured parser (markdown AST, PDF page-aware, DOCX section-aware).
- Add an embedding-similarity semantic-split pass (on by default) for long uniform sections.
- Add server-side context expansion: `expand=none|siblings|sections` on `/search`, `/search/rag`, `/chat` for richer multi-chunk answers.
- Hard-code-free, with metadata (heading path, page number, block kind) threaded all the way to Qdrant for stronger citations.
- Bake in the bug/security/quality items identified in the codebase review (path traversal, XSS, /chat memory, graceful shutdown, parallel embedding, payload indexes, MIME types, graceful Docker start, `noImplicitAny`, dead code, etc.).
- Bring test coverage up to a level where the chunker and parser have ≥ 90% line coverage and the project hits ≥ 80% overall.

## Future work (out of scope this phase)

- **LLM-driven agent loop (Phase 02).** Replace the static `expand` parameter with an LLM tool-use loop exposing `get_neighbor_chunks`, `get_section_chunks`, `get_chunk`, and `get_document` as tools. Default mode becomes `expand=auto` where the LLM decides when to call tools. Loop bounds (per Phase 02 spec): max **3 iterations**, tool-result text capped at **10K tokens** per iteration, both configurable via env. Tool calls surfaced to the client in `response.toolCalls` for human-transparency ("show me how the LLM got its answer"). No streaming this phase (deferred).
- Hierarchical / parent-child chunk storage.
- Cross-encoder re-ranking.
- Streaming chat responses.
- Authn / authz / multi-tenancy.
- Document deletion endpoint.

## Decisions deferred to review
See `requirements.md` → "Open questions" and `design.md` → "Open decisions". Please flag any you want changed before implementation starts.