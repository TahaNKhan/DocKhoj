-- Phase 04 / p4-T14: per-user chat-session ownership.
--
-- One ALTER on the existing `conversations` table (created in
-- 001_init.sql, touched by 002_title_source.sql).
--
-- owner_id: nullable FK to users.id with ON DELETE CASCADE — when a user
-- is deleted, their owned conversations cascade, taking messages with
-- them via the existing messages.conversation_id FK. The NULL case is
-- a transitional/legacy state for chat sessions created pre-Phase-04
-- (the DELETE below nukes every pre-existing row anyway) and for any
-- session created by an unauthenticated code path (the chat routes
-- themselves stamp owner_id in p4-T11; this migration only adds the
-- column + clears pre-Phase-04 rows).
--
-- DESTRUCTIVE: `DELETE FROM conversations;` is intentional per the
-- design decision ("Drop pre-phase-4 conversations" — see OD-6 in
-- design.md). The user explicitly chose a clean slate; messages
-- cascade via the existing ON DELETE CASCADE FK.
--
-- IDEMPOTENCY NOTE: the migration runner tracks applied IDs in
-- _migrations, so this file's ALTER + DELETE only run once. CREATE
-- INDEX IF NOT EXISTS guards the index against any partial re-apply.

ALTER TABLE conversations ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;

DELETE FROM conversations;

-- ponytail: "list my sessions" (GET /api/sessions) orders by updated_at
-- DESC filtered by owner_id. The composite (owner_id, updated_at DESC)
-- gives a covering index for that single query; we keep it narrow
-- (single column) per the project index-trimming convention since the
-- existing idx_conversations_updated_at still helps when the
-- owner_id filter is omitted. Add the new one to support the
-- WHERE owner_id = ? ORDER BY updated_at DESC path.
CREATE INDEX IF NOT EXISTS idx_conversations_owner_id
  ON conversations (owner_id);
