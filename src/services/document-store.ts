import type Database from 'better-sqlite3';

type DB = Database.Database;

// DocumentStore — SQLite-backed persistence for uploaded documents.
// Backed by the `documents` table (migration 003_documents.sql).
//
// Row identity is `file_id` (UUIDv4). The on-disk filename is
// `${file_id}${ext}` — derived from `file_name` on the row. The store
// doesn't touch the filesystem; that's the route handler's job (see
// `src/routes/api-documents.ts`).
//
// Convention: timestamps are stored as SQLite TEXT (`YYYY-MM-DD
// HH:MM:SS` UTC). Returned as opaque strings; the SPA formats for
// display.

// Phase 04 / p4-T10 / FR-34 — ownerId + ownerUsername + visibility are
// populated by `list()` (via JOIN on users) and `get()` /
// `getByFileName()`. They're null/undefined for shared (owner_id IS
// NULL) legacy rows. The route handler in api-documents.ts sends
// them straight through to the SPA — Upload.tsx uses them to render
// the chip, DocumentsList.tsx uses them to render the Owner column.
export interface DocumentRow {
  fileId: string;
  fileName: string;
  fileType: string;
  bytes: number;
  uploadedAt: string;
  chunkCount: number;
  ownerId: string | null;
  ownerUsername: string | null;
  visibility: 'public' | 'private';
}

interface DocumentDbRow {
  file_id: string;
  file_name: string;
  file_type: string;
  bytes: number;
  uploaded_at: string;
  chunk_count: number;
  owner_id: string | null;
  owner_username: string | null;
  visibility: string;
}

// Phase 04 / p4-T07 / FR-16 — shape used by the admin "delete user"
// cascade. Distinct from `DocumentRow` (which carries no ownership /
// visibility fields) so the list-and-delete payloads stay narrow.
export interface OwnedDocument {
  fileId: string;
  fileName: string;
  visibility: 'public' | 'private';
}

interface OwnedDocumentDbRow {
  file_id: string;
  file_name: string;
  visibility: string;
}

// Phase 04 / p4-T09 / FR-27 — owner_id + visibility stamped from
// the authenticated user + the upload form field. The read side
// (DocumentRow.ownerId/visibility) is added in T11 (GET /api/documents).
export interface InsertDocument {
  fileId: string;
  fileName: string;
  fileType: string;
  bytes: number;
  uploadedAt: string;
  chunkCount: number;
  ownerId: string | null;
  visibility: 'public' | 'private';
}

export class DocumentStore {
  constructor(private readonly db: DB) {}

  /** Insert a new document row. The caller has already written the
   *  file to disk and pushed its chunks to Qdrant; this is the
   *  third (and last) step. `uploadedAt` should be a SQLite-format
   *  timestamp (YYYY-MM-DD HH:MM:SS). */
  insert(row: InsertDocument): void {
    this.db
      .prepare(
        `INSERT INTO documents
           (file_id, file_name, file_type, bytes, uploaded_at, chunk_count, owner_id, visibility)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.fileId,
        row.fileName,
        row.fileType,
        row.bytes,
        row.uploadedAt,
        row.chunkCount,
        row.ownerId,
        row.visibility
      );
  }

  /** All documents the viewer can see, most-recently-uploaded first.
   *  Empty array if the viewer has no documents (not null — keeps
   *  the SPA's `length === 0` branch simple). The WHERE clause is
   *  the same predicate used by the /api/documents HTTP route per
   *  FR-34: `owner_id = viewerId OR owner_id IS NULL`. The LEFT JOIN
   *  onto `users` populates `ownerUsername` (null for shared rows).
   *  `count()` is left alone — T15 turns it into a viewer-scoped
   *  variant for /api/status. */
  list(viewerId: string): DocumentRow[] {
    const rows = this.db
      .prepare(
        `SELECT d.file_id, d.file_name, d.file_type, d.bytes,
                d.uploaded_at, d.chunk_count,
                d.owner_id, u.username AS owner_username, d.visibility
         FROM documents d
         LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.owner_id = ? OR d.owner_id IS NULL
         ORDER BY d.uploaded_at DESC, d.file_id DESC`
      )
      .all(viewerId) as DocumentDbRow[];
    return rows.map(toDocumentRow);
  }

  /** Look up a single row by fileId. Used by the DELETE route
   *  handler to recover the on-disk filename before unlinking, and
   *  by download.ts to authorize the request before streaming.
   *  Returns ownership fields so the caller can enforce FR-35/36
   *  (foreign files → 404). */
  get(fileId: string): DocumentRow | null {
    const row = this.db
      .prepare(
        `SELECT d.file_id, d.file_name, d.file_type, d.bytes,
                d.uploaded_at, d.chunk_count,
                d.owner_id, u.username AS owner_username, d.visibility
         FROM documents d
         LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.file_id = ?`
      )
      .get(fileId) as DocumentDbRow | undefined;
    return row ? toDocumentRow(row) : null;
  }

  /** Look up a row by its user-facing fileName (e.g. "notes.md").
   *  Used by the agent tool `get_document` as a fallback when the
   *  LLM passes the fileName it saw in the source list instead of
   *  the on-disk basename. If multiple uploads share the same
   *  fileName, returns the most-recently-uploaded one. Returns null
   *  when no row matches. */
  getByFileName(fileName: string): DocumentRow | null {
    const row = this.db
      .prepare(
        `SELECT d.file_id, d.file_name, d.file_type, d.bytes,
                d.uploaded_at, d.chunk_count,
                d.owner_id, u.username AS owner_username, d.visibility
         FROM documents d
         LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.file_name = ?
         ORDER BY d.uploaded_at DESC, d.file_id DESC
         LIMIT 1`
      )
      .get(fileName) as DocumentDbRow | undefined;
    return row ? toDocumentRow(row) : null;
  }

  /** Remove a row by fileId. Idempotent — returns `true` if a row
   *  was deleted, `false` if no such row existed. */
  delete(fileId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM documents WHERE file_id = ?`)
      .run(fileId);
    return result.changes > 0;
  }

  /** Count of rows. Used by /api/status for the TopBar chrome. */
  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM documents`)
      .get() as { c: number };
    return row.c;
  }

  /** Phase 04 / p4-T07 / FR-16 — documents owned by the given user
   *  with visibility='private'. The admin user-delete cascade uses
   *  this to know which chunks + on-disk files to remove before
   *  deleting the SQLite row. Public-owned files are intentionally
   *  excluded (they become shared via `ON DELETE SET NULL` on
   *  `documents.owner_id` when the user row goes). */
  findPrivateByOwner(ownerId: string): OwnedDocument[] {
    const rows = this.db
      .prepare(
        `SELECT file_id, file_name, visibility
         FROM documents
         WHERE owner_id = ? AND visibility = 'private'`,
      )
      .all(ownerId) as OwnedDocumentDbRow[];
    return rows.map(toOwnedDocument);
  }
}

function toOwnedDocument(r: OwnedDocumentDbRow): OwnedDocument {
  return {
    fileId: r.file_id,
    fileName: r.file_name,
    visibility: r.visibility as 'public' | 'private',
  };
}

function toDocumentRow(r: DocumentDbRow): DocumentRow {
  return {
    fileId: r.file_id,
    fileName: r.file_name,
    fileType: r.file_type,
    bytes: r.bytes,
    uploadedAt: r.uploaded_at,
    chunkCount: r.chunk_count,
    ownerId: r.owner_id,
    ownerUsername: r.owner_username,
    visibility: r.visibility as 'public' | 'private',
  };
}