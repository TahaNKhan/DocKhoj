import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { DocumentStore } from '../../src/services/document-store.js';

// p3-T01 tests — DocumentStore CRUD against an in-memory DB. Covers
// the FR-1 / FR-2 / FR-7 acceptance: insert on upload, list in
// uploaded_at DESC order, idempotent delete, get-by-id, count for
// /api/status.

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
    store.insert({
      fileId: 'file-abc',
      fileName: 'notes.md',
      fileType: 'md',
      bytes: 1024,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 12,
    });

    const row = store.get('file-abc');
    expect(row).toEqual({
      fileId: 'file-abc',
      fileName: 'notes.md',
      fileType: 'md',
      bytes: 1024,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 12,
    });
  });

  it('insert throws on duplicate file_id (PRIMARY KEY)', () => {
    store.insert({
      fileId: 'dup',
      fileName: 'a.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 0,
    });
    expect(() =>
      store.insert({
        fileId: 'dup',
        fileName: 'b.md',
        fileType: 'md',
        bytes: 1,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 0,
      })
    ).toThrow();
  });

  it('list returns rows in uploaded_at DESC order', async () => {
    store.insert({
      fileId: 'a',
      fileName: 'a.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 0,
    });
    await sleep(SECOND);
    store.insert({
      fileId: 'b',
      fileName: 'b.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:01',
      chunkCount: 0,
    });
    await sleep(SECOND);
    store.insert({
      fileId: 'c',
      fileName: 'c.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:02',
      chunkCount: 0,
    });

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
    store.insert({
      fileId: 'gone',
      fileName: 'gone.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 0,
    });
    expect(store.get('gone')).not.toBeNull();
    expect(store.delete('gone')).toBe(true);
    expect(store.get('gone')).toBeNull();
  });

  it('delete returns false for an unknown fileId (idempotent)', () => {
    expect(store.delete('nope')).toBe(false);
  });

  it('count reflects the number of rows', () => {
    expect(store.count()).toBe(0);
    store.insert({
      fileId: 'a',
      fileName: 'a.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 0,
    });
    expect(store.count()).toBe(1);
    store.insert({
      fileId: 'b',
      fileName: 'b.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:01',
      chunkCount: 0,
    });
    expect(store.count()).toBe(2);
    store.delete('a');
    expect(store.count()).toBe(1);
  });

  it('handles two uploads of the same original filename with distinct fileIds', () => {
    store.insert({
      fileId: 'file-1',
      fileName: 'notes.md',
      fileType: 'md',
      bytes: 100,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 5,
    });
    store.insert({
      fileId: 'file-2',
      fileName: 'notes.md',
      fileType: 'md',
      bytes: 200,
      uploadedAt: '2026-07-01 10:00:01',
      chunkCount: 7,
    });

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