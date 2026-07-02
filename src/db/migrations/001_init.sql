-- Phase 02 / p2-T05: conversation persistence.
--
-- Schema decisions:
-- - conversations: id is UUIDv4 (matches the existing regex
--   ^[A-Za-z0-9_-]{1,64}$). title defaults to 'New chat' until the
--   async LLM title generator (p2-p1-T10) overwrites it. updated_at is
--   the source of truth for sidebar ordering.
-- - messages: role constrained to user/assistant at the DB layer.
--   sources is a JSON-encoded array of Source objects (set only on
--   assistant rows). FK to conversations with ON DELETE CASCADE so
--   removing a session purges its history.
-- - _migrations: applied-set tracker for the migration runner.
--
-- PRAGMA journal_mode = WAL and PRAGMA foreign_keys = ON are set at
-- every connection open (see src/db/index.ts); they aren't durable in
-- the schema. The runner also re-applies the table-creating statements
-- idempotently (CREATE TABLE IF NOT EXISTS) so a partial apply
-- self-heals on the next boot.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  sources TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_created_at
  ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
