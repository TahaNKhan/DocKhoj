import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { DocumentStore } from '../../src/services/document-store.js';
import { documentRoutes } from '../../src/routes/api-documents.js';
import { UserStore } from '../../src/services/user-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';

const { mockDeleteByFilePath } = vi.hoisted(() => ({
  mockDeleteByFilePath: vi.fn(),
}));

vi.mock('../../src/services/qdrant.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/qdrant.js')>(
    '../../src/services/qdrant.js'
  );
  return {
    ...actual,
    deleteByFilePath: mockDeleteByFilePath,
  };
});

// p3-T02 + p4-T10 tests — /api/documents route surface via
// fastify.inject, with the real authPlugin so request.user is
// populated from the cookie. A viewer-scoped GET / DELETE surface
// replaces the previous "list all" / "delete whatever" behavior.
// Covers:
//  - GET returns rows in uploaded_at DESC order; [] when empty.
//  - GET response shape gains ownerUsername + visibility (FR-34).
//  - GET is scoped to viewer: own + shared; never another user's
//    private files (FR-34, FR-40).
//  - DELETE happy path: 200 + {success, chunksDeleted, fileId}.
//  - DELETE 400 invalid fileId.
//  - DELETE 404 unknown fileId.
//  - DELETE 404 when the file belongs to another user (FR-35).
//  - DELETE allowed for a shared file (owner_id IS NULL).
//  - DELETE 500 when Qdrant throws; disk + SQLite untouched.
//  - DELETE re-delete after success → 404.

describe('/api/documents', () => {
  let db: ReturnType<typeof Database>;
  let tempDir: string;
  let origCwd: string;
  let origUploadDir: string | undefined;
  let app: ReturnType<typeof Fastify>;
  let viewerId: string;
  let viewerCookie: string;
  let userId: string;
  let userCookie: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockhoj-docs-'));
    origCwd = process.cwd();
    process.chdir(tempDir);
    origUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = path.join(tempDir, 'documents');
    await fs.mkdir(process.env.UPLOAD_DIR, { recursive: true });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);

    mockDeleteByFilePath.mockReset();
    mockDeleteByFilePath.mockResolvedValue(0);

    // Two users for the cross-user scoping tests.
    const users = new UserStore(db);
    const sessions = new AuthSessionStore(db);
    const viewer = await users.createUser({
      username: 'viewer',
      password: 'viewer-pass-123!',
      role: 'user',
    });
    viewerId = viewer.id;
    viewerCookie = `dockhoj_sid=${sessions.create(viewerId).id}`;
    const other = await users.createUser({
      username: 'other',
      password: 'other-pass-123!',
      role: 'user',
    });
    userId = other.id;
    userCookie = `dockhoj_sid=${sessions.create(userId).id}`;

    app = Fastify({ logger: false });
    app.decorate('db', db);
    await app.register(authPlugin);
    await app.register(documentRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    if (origUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = origUploadDir;
    process.chdir(origCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('GET /api/documents', () => {
    it('returns {documents: []} when the table is empty', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ documents: [] });
    });

    it('401 when no session cookie is supplied', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/documents' });
      expect(res.statusCode).toBe(401);
      expect(mockDeleteByFilePath).not.toHaveBeenCalled();
    });

    it('returns rows in uploaded_at DESC order with the expected shape (FR-34)', async () => {
      const store = new DocumentStore(db);
      store.insert({
        fileId: 'older',
        fileName: 'old.md',
        fileType: 'md',
        bytes: 100,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 4,
        ownerId: viewerId,
        visibility: 'public',
      });
      await sleep(SECOND);
      store.insert({
        fileId: 'newer',
        fileName: 'new.md',
        fileType: 'md',
        bytes: 200,
        uploadedAt: '2026-07-01 10:00:01',
        chunkCount: 6,
        ownerId: viewerId,
        visibility: 'public',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/documents',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        documents: [
          {
            fileId: 'newer',
            fileName: 'new.md',
            fileType: 'md',
            bytes: 200,
            uploadedAt: '2026-07-01 10:00:01',
            chunkCount: 6,
            ownerId: viewerId,
            ownerUsername: 'viewer',
            visibility: 'public',
          },
          {
            fileId: 'older',
            fileName: 'old.md',
            fileType: 'md',
            bytes: 100,
            uploadedAt: '2026-07-01 10:00:00',
            chunkCount: 4,
            ownerId: viewerId,
            ownerUsername: 'viewer',
            visibility: 'public',
          },
        ],
      });
    });

    it('shared rows (owner_id IS NULL) appear with ownerId=null, ownerUsername=null', async () => {
      const store = new DocumentStore(db);
      store.insert({
        fileId: 'shared',
        fileName: 'shared.md',
        fileType: 'md',
        bytes: 1,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 1,
        ownerId: null,
        visibility: 'public',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/documents',
        headers: { cookie: viewerCookie },
      });
      expect(res.json()).toEqual({
        documents: [
          {
            fileId: 'shared',
            fileName: 'shared.md',
            fileType: 'md',
            bytes: 1,
            uploadedAt: '2026-07-01 10:00:00',
            chunkCount: 1,
            ownerId: null,
            ownerUsername: null,
            visibility: 'public',
          },
        ],
      });
    });

    it("does not return another user's private files (FR-34)", async () => {
      const store = new DocumentStore(db);
      // Viewer owns one file; the other user owns a private and a public file.
      store.insert({
        fileId: 'mine',
        fileName: 'mine.md',
        fileType: 'md',
        bytes: 1,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 1,
        ownerId: viewerId,
        visibility: 'private',
      });
      store.insert({
        fileId: 'theirs-private',
        fileName: 'theirs-private.md',
        fileType: 'md',
        bytes: 2,
        uploadedAt: '2026-07-01 10:00:01',
        chunkCount: 2,
        ownerId: userId,
        visibility: 'private',
      });
      store.insert({
        fileId: 'theirs-public',
        fileName: 'theirs-public.md',
        fileType: 'md',
        bytes: 3,
        uploadedAt: '2026-07-01 10:00:02',
        chunkCount: 3,
        ownerId: userId,
        visibility: 'public',
      });
      store.insert({
        fileId: 'shared-legacy',
        fileName: 'shared-legacy.md',
        fileType: 'md',
        bytes: 4,
        uploadedAt: '2026-07-01 10:00:03',
        chunkCount: 4,
        ownerId: null,
        visibility: 'public',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/documents',
        headers: { cookie: viewerCookie },
      });
      const ids = res.json().documents.map((d: { fileId: string }) => d.fileId).sort();
      // FR-34: viewer sees their OWN files + shared (owner_id IS NULL).
      // Public-marked files owned by another user are NOT shared — they
      // just have search-visibility turned on. So viewer sees:
      //   own private ('mine') + shared legacy.
      expect(ids).toEqual(['mine', 'shared-legacy']);

      // Other user sees their own + shared legacy; not viewer's private file.
      const otherRes = await app.inject({
        method: 'GET',
        url: '/api/documents',
        headers: { cookie: userCookie },
      });
      const otherIds = otherRes.json().documents.map((d: { fileId: string }) => d.fileId).sort();
      expect(otherIds).toEqual(['shared-legacy', 'theirs-private', 'theirs-public']);
    });
  });

  describe('DELETE /api/documents/:fileId', () => {
    it('400 on invalid fileId', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/documents/has spaces',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Invalid fileId' });
      expect(mockDeleteByFilePath).not.toHaveBeenCalled();
    });

    it('400 on fileId with a path-traversal attempt', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/documents/..%2Fetc%2Fpasswd',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(400);
      expect(mockDeleteByFilePath).not.toHaveBeenCalled();
    });

    it('404 on unknown fileId', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/documents/never-existed',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Document not found' });
      expect(mockDeleteByFilePath).not.toHaveBeenCalled();
    });

    it('happy path — removes the file, calls Qdrant with the on-disk name, deletes the row', async () => {
      const fileId = 'happy-path';
      const store = new DocumentStore(db);
      store.insert({
        fileId,
        fileName: 'doc.md',
        fileType: 'md',
        bytes: 12,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 3,
        ownerId: viewerId,
        visibility: 'private',
      });
      const onDiskPath = path.join(process.env.UPLOAD_DIR!, `${fileId}.md`);
      await fs.writeFile(onDiskPath, '# hello');

      mockDeleteByFilePath.mockResolvedValueOnce(3);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        chunksDeleted: 3,
        fileId,
      });

      expect(mockDeleteByFilePath).toHaveBeenCalledWith(`${fileId}.md`);
      await expect(fs.stat(onDiskPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(store.get(fileId)).toBeNull();
    });

    it('404 when the file belongs to another user (FR-35, no enumeration)', async () => {
      const store = new DocumentStore(db);
      store.insert({
        fileId: 'foreign',
        fileName: 'foreign.md',
        fileType: 'md',
        bytes: 1,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 1,
        ownerId: userId,
        visibility: 'private',
      });
      const onDiskPath = path.join(process.env.UPLOAD_DIR!, 'foreign.md');
      await fs.writeFile(onDiskPath, '# foreign');

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/documents/foreign',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Document not found' });
      // Qdrant NOT called; foreign file untouched on disk.
      expect(mockDeleteByFilePath).not.toHaveBeenCalled();
      await expect(fs.stat(onDiskPath)).resolves.toBeDefined();
      expect(store.get('foreign')).not.toBeNull();
    });

    it('succeeds for a shared (owner_id IS NULL) file even when requested by a non-owner (FR-35)', async () => {
      const store = new DocumentStore(db);
      store.insert({
        fileId: 'shared',
        fileName: 'shared.md',
        fileType: 'md',
        bytes: 1,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 1,
        ownerId: null,
        visibility: 'public',
      });
      const onDiskPath = path.join(process.env.UPLOAD_DIR!, 'shared.md');
      await fs.writeFile(onDiskPath, '# shared');

      mockDeleteByFilePath.mockResolvedValueOnce(1);
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/documents/shared',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(mockDeleteByFilePath).toHaveBeenCalledWith('shared.md');
      expect(store.get('shared')).toBeNull();
    });

    it('500 on Qdrant failure — disk + SQLite untouched', async () => {
      const fileId = 'qdrant-fail';
      const store = new DocumentStore(db);
      store.insert({
        fileId,
        fileName: 'doc.md',
        fileType: 'md',
        bytes: 12,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 3,
        ownerId: viewerId,
        visibility: 'private',
      });
      const onDiskPath = path.join(process.env.UPLOAD_DIR!, `${fileId}.md`);
      await fs.writeFile(onDiskPath, '# hello');

      mockDeleteByFilePath.mockRejectedValueOnce(new Error('qdrant unreachable'));

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Failed to delete chunks' });

      // disk + row preserved
      await expect(fs.stat(onDiskPath)).resolves.toBeDefined();
      expect(store.get(fileId)).not.toBeNull();
    });

    it('tolerates a missing on-disk file (logs at debug, still removes the row)', async () => {
      const fileId = 'no-file';
      const store = new DocumentStore(db);
      store.insert({
        fileId,
        fileName: 'ghost.md',
        fileType: 'md',
        bytes: 12,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 3,
        ownerId: viewerId,
        visibility: 'private',
      });

      mockDeleteByFilePath.mockResolvedValueOnce(0);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        chunksDeleted: 0,
        fileId,
      });
      expect(store.get(fileId)).toBeNull();
    });

    it('idempotent: re-DELETE returns 404', async () => {
      const fileId = 're-delete';
      const store = new DocumentStore(db);
      store.insert({
        fileId,
        fileName: 'doc.md',
        fileType: 'md',
        bytes: 1,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 1,
        ownerId: viewerId,
        visibility: 'private',
      });
      await fs.writeFile(path.join(process.env.UPLOAD_DIR!, `${fileId}.md`), '# x');
      mockDeleteByFilePath.mockResolvedValue(1);

      const first = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
        headers: { cookie: viewerCookie },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
        headers: { cookie: viewerCookie },
      });
      expect(second.statusCode).toBe(404);
      // Qdrant is only called on a hit — second DELETE short-circuits.
      expect(mockDeleteByFilePath).toHaveBeenCalledTimes(1);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// SQLite's datetime('now') is seconds-precision; ordering tests need
// to cross a second boundary.
const SECOND = 1100;
