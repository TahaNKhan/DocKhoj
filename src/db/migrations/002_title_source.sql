-- Phase 02 / p2-T06: Track how a session's title was set.
--
-- title_source values:
--   'default'   — initial 'New chat'
--   'generated' — set by the LLM title generator (services/title-generator.ts)
--   'fallback'  — 60-char prefix of first user message (LLM call failed)
--   'user'      — set via PATCH /api/sessions/:id
--
-- Rules (enforced in services/conversations.ts):
-- - setGeneratedTitle may overwrite 'default' / 'fallback' (so the LLM
--   title wins on first exchange). It must NOT overwrite 'user' or
--   an existing 'generated' title.
-- - setFallbackTitle may overwrite 'default' only.
-- - PATCH /api/sessions/:id sets title_source = 'user'.

ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'default';
