# TASKS

Index of phase work. Each phase owns its own task list inside its spec
folder (`docs/specs/phase-NN-name/TASKS.md`) while it is active; when
the phase ships, the spec folder is deleted and the durable decisions
fold into [`docs/architecture.md`](./docs/architecture.md).

## Status

- **Phases 01–05 — folded.** Their spec folders (`docs/specs/phase-01…05/`)
  have been removed; their cross-cutting decisions live in
  `docs/architecture.md` and as `// why:` comments at the call sites.
  The git log retains the per-phase commit history.

- **Active phase:** none currently in flight. To start a new phase,
  create `docs/specs/phase-NN-short-name/` per the `spec-workflow`
  skill, with its own `README.md` / `requirements.md` / `design.md` /
  `TASKS.md`.

## Numbering

Task IDs use the `pX-TYY` form: `p1-TYY` for Phase 01, `p2-TYY` for
Phase 02, etc. The leading `X` disambiguates phases; within a phase
the two-digit number is sequential. Historical references to the old
global `T<N>` form are preserved in a few places as
`(T49 in legacy numbering)` for cross-reference with the git log.

## Notes

- Per-phase task lists are append-only once a phase is folded. New
  follow-up work goes onto the active phase's list, not back into a
  folded phase's history.
- `docs/architecture.md` is the source of truth for *why* the system
  is shaped the way it is. The git log is the source of truth for
  *when* and *what* landed.
- If a task turns out to be larger than estimated during
  implementation, split it in the active phase's `TASKS.md` rather
  than letting it sprawl.
