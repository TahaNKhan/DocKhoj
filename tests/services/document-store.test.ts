import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { DocumentStore, type InsertDocument } from '../../src/services/document-store.js';

// p3-T01 tests — DocumentStore CRUD against an in-memory DB. Covers
// the FR-1 / FR-2 / FR-7 acceptance: insert on upload, list in
// uploaded_at DESC order, idempotent delete, get-by-id, count for
// /api/status.
// p4-T09 added owner_id + visibility to the insert payload. These
// CRUD tests don't care about the new fields — they just need the
// NOT NULL columns populated. `row` builds a payload with a
// nullable owner + a default 'public' visibility, so each `insert`
// call can spread it and override only the per-test fields.

function row(overrides: Partial<InsertDocument>): InsertDocument {
  return {
    fileId: 'default',
    fileName: 'default.md',
    fileType: 'md',
    bytes: 0,
    uploadedAt: '2026-07-01 10:00:00',
    chunkCount: 0,
    ownerId: null,
    visibility: 'public',
    ...overrides,
  };
}

describe('DocumentStore', () => {
  let db: ReturnType<typeof Database>;
  let store: DocumentStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    store = new DocumentStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('insert writes a row that can be retrieved by fileId', () => {
    store.insert(
      row({
        fileId: 'file-abc',
        fileName: 'notes.md',
        bytes: 1024,
        chunkCount: 12,
      })
    );

    const r = store.get('file-abc');
    expect(r).toEqual({
      fileId: 'file-abc',
      fileName: 'notes.md',
      fileType: 'md',
      bytes: 1024,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 12,
    });
  });

  it('insert throws on duplicate file_id (PRIMARY KEY)', () => {
    store.insert(row({ fileId: 'dup', fileName: 'a.md' }));
    expect(() =>
      store.insert(row({ fileId: 'dup', fileName: 'b.md' }))
    ).toThrow();
  });

  it('list returns rows in uploaded_at DESC order', async () => {
    store.insert(row({ fileId: 'a', fileName: 'a.md' }));
    await sleep(SECOND);
    store.insert(row({ fileId: 'b', fileName: 'b.md', uploadedAt: '2026-07-01 10:00:01' }));
    await sleep(SECOND);
    store.insert(row({ fileId: 'c', fileName: 'c.md', uploadedAt: '2026-07-01 10:00:02' }));

    const ids = store.list().map((r) => r.fileId);
    expect(ids).toEqual(['c', 'b', 'a']);
  });

  it('list returns [] when the table is empty', () => {
    expect(store.list()).toEqual([]);
  });

  it('get returns null for an unknown fileId', () => {
    expect(store.get('nope')).toBeNull();
  });

  it('delete removes the row and returns true', () => {
    store.insert(row({ fileId: 'gone', fileName: 'gone.md' }));
    expect(store.get('gone')).not.toBeNull();
    expect(store.delete('gone')).toBe(true);
    expect(store.get('gone')).toBeNull();
  });

  it('delete returns false for an unknown fileId (idempotent)', () => {
    expect(store.delete('nope')).toBe(false);
  });

  it('count reflects the number of rows', () => {
    expect(store.count()).toBe(0);
    store.insert(row({ fileId: 'a', fileName: 'a.md' }));
    expect(store.count()).toBe(1);
    store.insert(row({ fileId: 'b', fileName: 'b.md', uploadedAt: '2026-07-01 10:00:01' }));
    expect(store.count()).toBe(2);
    store.delete('a');
    expect(store.count()).toBe(1);
  });

  it('handles two uploads of the same original filename with distinct fileIds', () => {
    store.insert(
      row({ fileId: 'file-1', fileName: 'notes.md', bytes: 100, chunkCount: 5 })
    );
    store.insert(
      row({ fileId: 'file-2', fileName: 'notes.md', bytes: 200, chunkCount: 7, uploadedAt: '2026-07-01 10:00:01' })
    );

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.fileId).sort()).toEqual(['file-1', 'file-2']);
    // Deleting one must not affect the other.
    expect(store.delete('file-1')).toBe(true);
    expect(store.get('file-2')).not.toBeNull();
    expect(store.get('file-1')).toBeNull();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// SQLite's datetime('now') is seconds-precision; tests that rely on
// ordering across inserts must cross a second boundary.
const SECOND = 1100;