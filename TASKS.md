# TASKS

Index of per-phase task lists. The root `TASKS.md` is **not** the active task tracker — each phase owns its own task file inside its spec folder, per the spec-workflow convention (see `~/.claude/CLAUDE.md` §6).

The currently-active phase (if any) is the only one with non-`done` tasks; all others are historical record.

## Per-phase task lists

- **Phase 01 — Smart Chunker & Cleanup** — [`docs/specs/phase-01-smart-chunker-and-cleanup/TASKS.md`](./docs/specs/phase-01-smart-chunker-and-cleanup/TASKS.md) — p1-T01 … p1-T21. **Done** (per spec README + git log `9bb6cf3` … `014a4f2`).
- **Phase 02 — Frontend, Streaming, and Persistence** — [`docs/specs/phase-02-frontend-streaming-and-persistence/TASKS.md`](./docs/specs/phase-02-frontend-streaming-and-persistence/TASKS.md) — p2-T01 … p2-T26 (p2-T21 … p2-T26 are post-spec priority follow-ups). **Done** (per spec README + git log `2c81035` … `6425682`).
- **Phase 03 — Document Deletion and Agentic RAG** — [`docs/specs/phase-03-document-deletion-and-agentic-rag/TASKS.md`](./docs/specs/phase-03-document-deletion-and-agentic-rag/TASKS.md) — p3-T01 … p3-T11. **Done**.

## Numbering

Task IDs use the `pX-TYY` form: `p1-TYY` for Phase 01, `p2-TYY` for Phase 02, `p3-TYY` for Phase 03. The leading `X` (1, 2, 3) disambiguates phases; within a phase the two-digit number is sequential. Historical references to the old `T<N>` form (where `N` was a global task number from the central `TASKS.md`) are preserved in a few places as `(T49 in legacy numbering)` for cross-reference with the Git log.

## Notes

- Per-phase task lists are append-only once a phase is `done`. New follow-up work goes onto the active phase's list, not back into a closed phase's list.
- Specs themselves (`requirements.md`, `design.md`, `README.md`) are the source of truth for *why* a phase happened and *what* it covered. `TASKS.md` is the ordered list of *how* it landed — commit hashes are the source of truth for *when*.
- If a task turns out to be larger than estimated during implementation, split it in the active phase's `TASKS.md` rather than letting it sprawl.