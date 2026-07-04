import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { DocumentStore, type InsertDocument } from '../../src/services/document-store.js';

// p3-T01 + p4-T10 tests — DocumentStore CRUD against an in-memory DB.
// Covers:
//   - FR-1 / FR-2 / FR-7 acceptance: insert on upload, list in
//     uploaded_at DESC order, idempotent delete, get-by-id, count.
//   - p4-T09: owner_id + visibility on insert.
//   - p4-T10: list(viewerId) scoping + ownerUsername populated via JOIN.
//   - p4-T10: get / getByFileName now return ownerId + ownerUsername +
//     visibility fields.
//
// `row` builds a payload with a nullable owner + a default 'public'
// visibility, so each `insert` call can spread it and override only
// the per-test fields. The two user ids (alice, bob) are seeded
// up-front so the ownership-JOIN tests can populate ownerUsername.

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

import { UserStore } from '../../src/services/user-store.js';

describe('DocumentStore', () => {
  let db: ReturnType<typeof Database>;
  let store: DocumentStore;
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    store = new DocumentStore(db);

    const users = new UserStore(db);
    aliceId = (
      await users.createUser({
        username: 'alice',
        password: 'alice-pass-123!',
        role: 'user',
      })
    ).id;
    bobId = (
      await users.createUser({
        username: 'bob',
        password: 'bob-pass-123!',
        role: 'user',
      })
    ).id;
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
        ownerId: aliceId,
        visibility: 'private',
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
      ownerId: aliceId,
      ownerUsername: 'alice',
      visibility: 'private',
    });
  });

  it('shared rows (owner_id IS NULL) round-trip with ownerId=null + ownerUsername=null', () => {
    store.insert(row({ fileId: 'shared', fileName: 'shared.md' }));
    expect(store.get('shared')).toEqual({
      fileId: 'shared',
      fileName: 'shared.md',
      fileType: 'md',
      bytes: 0,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 0,
      ownerId: null,
      ownerUsername: null,
      visibility: 'public',
    });
  });

  it('insert throws on duplicate file_id (PRIMARY KEY)', () => {
    store.insert(row({ fileId: 'dup', fileName: 'a.md' }));
    expect(() =>
      store.insert(row({ fileId: 'dup', fileName: 'b.md' }))
    ).toThrow();
  });

  it('list returns rows in uploaded_at DESC order', async () => {
    store.insert(row({ fileId: 'a', fileName: 'a.md', ownerId: aliceId }));
    await sleep(SECOND);
    store.insert(row({ fileId: 'b', fileName: 'b.md', uploadedAt: '2026-07-01 10:00:01', ownerId: aliceId }));
    await sleep(SECOND);
    store.insert(row({ fileId: 'c', fileName: 'c.md', uploadedAt: '2026-07-01 10:00:02', ownerId: aliceId }));

    const ids = store.list(aliceId).map((r) => r.fileId);
    expect(ids).toEqual(['c', 'b', 'a']);
  });

  it('list returns [] when the table is empty', () => {
    expect(store.list(aliceId)).toEqual([]);
  });

  it('list(viewerId) only returns documents the viewer can see (own + shared)', () => {
    store.insert(row({ fileId: 'alice-private', fileName: 'a1.md', ownerId: aliceId, visibility: 'private' }));
    store.insert(row({ fileId: 'alice-public', fileName: 'a2.md', ownerId: aliceId, visibility: 'public' }));
    store.insert(row({ fileId: 'bob-private', fileName: 'b1.md', ownerId: bobId, visibility: 'private' }));
    store.insert(row({ fileId: 'bob-public', fileName: 'b2.md', ownerId: bobId, visibility: 'public' }));
    store.insert(row({ fileId: 'shared', fileName: 'shared.md', ownerId: null, visibility: 'public' }));

    // Alice sees her own files + shared; not bob's private file.
    const aliceIds = store.list(aliceId).map((r) => r.fileId).sort();
    expect(aliceIds).toEqual(['alice-private', 'alice-public', 'shared']);

    // Bob sees his own files + shared; not alice's private file.
    const bobIds = store.list(bobId).map((r) => r.fileId).sort();
    expect(bobIds).toEqual(['bob-private', 'bob-public', 'shared']);
  });

  it('get populates ownerUsername via the users JOIN', () => {
    store.insert(row({ fileId: 'by-alice', fileName: 'a.md', ownerId: aliceId, visibility: 'private' }));
    expect(store.get('by-alice')?.ownerUsername).toBe('alice');
  });

  it('get returns null for an unknown fileId', () => {
    expect(store.get('nope')).toBeNull();
  });

  it('delete removes the row and returns true', () => {
    store.insert(row({ fileId: 'gone', fileName: 'gone.md', ownerId: aliceId }));
    expect(store.get('gone')).not.toBeNull();
    expect(store.delete('gone')).toBe(true);
    expect(store.get('gone')).toBeNull();
  });

  it('delete returns false for an unknown fileId (idempotent)', () => {
    expect(store.delete('nope')).toBe(false);
  });

  it('count returns the number of rows visible to the viewer (own + shared)', () => {
    // Per p4-T15, count() now scopes by viewerId. The 4 doc rows:
    //   alice-private → alice only
    //   alice-public  → alice + bob (public → shared-after-public-row)
    //   bob-private   → bob only
    //   bob-public    → bob + alice
    store.insert(row({ fileId: 'alice-private', fileName: 'a1.md', ownerId: aliceId, visibility: 'private' }));
    store.insert(row({ fileId: 'alice-public', fileName: 'a2.md', ownerId: aliceId, visibility: 'public' }));
    store.insert(row({ fileId: 'bob-private', fileName: 'b1.md', ownerId: bobId, visibility: 'private' }));
    store.insert(row({ fileId: 'bob-public', fileName: 'b2.md', ownerId: bobId, visibility: 'public' }));
    expect(store.count(aliceId)).toBe(3);
    expect(store.count(bobId)).toBe(3);
    // An empty viewerId still matches shared (owner_id IS NULL).
    expect(store.count('')).toBe(0);
  });

  it('count hides foreign private files from the viewer', () => {
    store.insert(row({ fileId: 'alice-private', fileName: 'a.md', ownerId: aliceId, visibility: 'private' }));
    store.insert(row({ fileId: 'bob-private', fileName: 'b.md', ownerId: bobId, visibility: 'private' }));
    // Bob should not see Alice's private file in the documents count.
    expect(store.count(bobId)).toBe(0);
    expect(store.count(aliceId)).toBe(1);
  });

  it('handles two uploads of the same original filename with distinct fileIds', () => {
    store.insert(
      row({ fileId: 'file-1', fileName: 'notes.md', bytes: 100, chunkCount: 5, ownerId: aliceId })
    );
    store.insert(
      row({ fileId: 'file-2', fileName: 'notes.md', bytes: 200, chunkCount: 7, uploadedAt: '2026-07-01 10:00:01', ownerId: aliceId })
    );

    const list = store.list(aliceId);
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.fileId).sort()).toEqual(['file-1', 'file-2']);
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