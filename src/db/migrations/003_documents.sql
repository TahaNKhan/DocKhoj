-- Phase 03 / p3-T01: track uploaded documents so we can list and delete
-- them.
--
-- file_id is the SAME UUIDv4 used in the on-disk filename (the existing
-- upload route does `${fileId}${ext}` to derive the on-disk name).
-- It's the public API identifier — DELETE /api/documents/:fileId.
--
-- file_name is the original user-facing filename. Can repeat across
-- rows if the same file is uploaded twice (each gets a fresh UUID).
-- Not unique.
--
-- file_type is the lower-case extension without the dot (e.g. 'pdf',
-- 'md'). Matches the existing chunk payload's `fileType` field.
--
-- bytes is the size of the uploaded file on disk. Surfaced in the
-- Documents list for UX.
--
-- uploaded_at is the SQLite `datetime('now')` of the successful
-- upsert — NOT the time the file landed on disk (which could be a
-- few ms earlier if the disk write completed first).
--
-- chunk_count is the number of Qdrant points whose payload.filePath
-- equals `${fileId}${ext}`. Updated on upload completion; not
-- recomputed on delete (delete returns the count it actually
-- removed from Qdrant, but the SQLite row is gone by then).
--
-- No FK to messages — conversations cite files via path/name, not
-- by file_id. Source chips in old assistant messages survive
-- document deletion (they're historical; the user already saw them).

CREATE TABLE IF NOT EXISTS documents (
  file_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  chunk_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at
  ON documents (uploaded_at DESC);