-- Phase 04 / p4-T02: per-user document ownership + visibility.
--
-- Two ALTERs to the existing `documents` table (created in 003_documents.sql).
--
-- owner_id: nullable. FK to users.id with ON DELETE SET NULL — when a user
-- is deleted, their private documents are also deleted by the admin route
-- handler (cascading row + chunk + on-disk file removal), but a public-marked
-- file the user owned becomes shared (owner_id flips to NULL). The SET NULL
-- behavior here is the safety net for the case where admin route deletion
-- is bypassed (e.g. direct DB manipulation in a recovery).
--
-- visibility: NOT NULL with default 'public'. So all pre-Phase-04 documents
-- get visibility='public' and owner_id=NULL — they appear in every user's
-- document list (the "shared bucket").
--
-- The CHECK constraint enforces the binary visibility model; the field is
-- not nullable by design so the SPA / API don't have to handle a third
-- "unspecified" state.
--
-- IDEMPOTENCY NOTE: the migration runner tracks applied IDs in _migrations,
-- so this file's ALTERs only run once per database. CREATE INDEX IF NOT
-- EXISTS guards the index against any partial re-apply.

ALTER TABLE documents ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'private'));

CREATE INDEX IF NOT EXISTS idx_documents_owner_id
  ON documents (owner_id);

CREATE INDEX IF NOT EXISTS idx_documents_visibility
  ON documents (visibility);
