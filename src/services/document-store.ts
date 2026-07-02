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

export interface DocumentRow {
  fileId: string;
  fileName: string;
  fileType: string;
  bytes: number;
  uploadedAt: string;
  chunkCount: number;
}

interface DocumentDbRow {
  file_id: string;
  file_name: string;
  file_type: string;
  bytes: number;
  uploaded_at: string;
  chunk_count: number;
}

export interface InsertDocument {
  fileId: string;
  fileName: string;
  fileType: string;
  bytes: number;
  uploadedAt: string;
  chunkCount: number;
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
           (file_id, file_name, file_type, bytes, uploaded_at, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.fileId,
        row.fileName,
        row.fileType,
        row.bytes,
        row.uploadedAt,
        row.chunkCount
      );
  }

  /** All documents, most-recently-uploaded first. Empty array if
   *  the table is empty (not null — keeps the SPA's `length === 0`
   *  branch simple). */
  list(): DocumentRow[] {
    const rows = this.db
      .prepare(
        `SELECT file_id, file_name, file_type, bytes, uploaded_at, chunk_count
         FROM documents
         ORDER BY uploaded_at DESC, file_id DESC`
      )
      .all() as DocumentDbRow[];
    return rows.map(toDocumentRow);
  }

  /** Look up a single row by fileId. Used by the DELETE route
   *  handler to recover the on-disk filename before unlinking. */
  get(fileId: string): DocumentRow | null {
    const row = this.db
      .prepare(
        `SELECT file_id, file_name, file_type, bytes, uploaded_at, chunk_count
         FROM documents WHERE file_id = ?`
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
        `SELECT file_id, file_name, file_type, bytes, uploaded_at, chunk_count
         FROM documents WHERE file_name = ?
         ORDER BY uploaded_at DESC, file_id DESC
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
}

function toDocumentRow(r: DocumentDbRow): DocumentRow {
  return {
    fileId: r.file_id,
    fileName: r.file_name,
    fileType: r.file_type,
    bytes: r.bytes,
    uploadedAt: r.uploaded_at,
    chunkCount: r.chunk_count,
  };
}