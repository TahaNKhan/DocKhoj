import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { DocumentStore } from '../../src/services/document-store.js';
import { documentRoutes } from '../../src/routes/api-documents.js';

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

// p3-T02 tests — /api/documents route surface. Covers:
//  - GET returns rows in uploaded_at DESC order; [] when empty.
//  - DELETE happy path: 200 + {success, chunksDeleted, fileId},
//    row + on-disk file gone, Qdrant delete called with the
//    on-disk name.
//  - DELETE 400 invalid fileId.
//  - DELETE 404 unknown fileId.
//  - DELETE 500 when Qdrant throws; disk + SQLite untouched.
//  - DELETE re-delete after success → 404 (idempotent from the SPA).

describe('/api/documents', () => {
  let db: ReturnType<typeof Database>;
  let tempDir: string;
  let origCwd: string;
  let origUploadDir: string | undefined;
  let app: ReturnType<typeof Fastify>;

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

    app = Fastify();
    app.decorate('db', db);
    await app.register(documentRoutes);
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
      const res = await app.inject({ method: 'GET', url: '/api/documents' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ documents: [] });
    });

    it('returns rows in uploaded_at DESC order with the expected shape', async () => {
      const store = new DocumentStore(db);
      store.insert({
        fileId: 'older',
        fileName: 'old.md',
        fileType: 'md',
        bytes: 100,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 4,
      ownerId: null,
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
      ownerId: null,
      visibility: 'public',
      });

      const res = await app.inject({ method: 'GET', url: '/api/documents' });
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
          },
          {
            fileId: 'older',
            fileName: 'old.md',
            fileType: 'md',
            bytes: 100,
            uploadedAt: '2026-07-01 10:00:00',
            chunkCount: 4,
          },
        ],
      });
    });
  });

  describe('DELETE /api/documents/:fileId', () => {
    it('400 on invalid fileId', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/documents/has spaces',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Invalid fileId' });
      expect(mockDeleteByFilePath).not.toHaveBeenCalled();
    });

    it('400 on fileId with a path-traversal attempt', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/documents/..%2Fetc%2Fpasswd',
      });
      expect(res.statusCode).toBe(400);
      expect(mockDeleteByFilePath).not.toHaveBeenCalled();
    });

    it('404 on unknown fileId', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/documents/never-existed',
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
      ownerId: null,
      visibility: 'public',
      });
      const onDiskPath = path.join(process.env.UPLOAD_DIR!, `${fileId}.md`);
      await fs.writeFile(onDiskPath, '# hello');

      mockDeleteByFilePath.mockResolvedValueOnce(3);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        chunksDeleted: 3,
        fileId,
      });

      expect(mockDeleteByFilePath).toHaveBeenCalledWith(`${fileId}.md`);
      // file gone
      await expect(fs.stat(onDiskPath)).rejects.toMatchObject({ code: 'ENOENT' });
      // row gone
      expect(store.get(fileId)).toBeNull();
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
      ownerId: null,
      visibility: 'public',
      });
      const onDiskPath = path.join(process.env.UPLOAD_DIR!, `${fileId}.md`);
      await fs.writeFile(onDiskPath, '# hello');

      mockDeleteByFilePath.mockRejectedValueOnce(new Error('qdrant unreachable'));

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
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
      ownerId: null,
      visibility: 'public',
      });
      // Don't write a file — delete must still succeed.

      mockDeleteByFilePath.mockResolvedValueOnce(0);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
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
      ownerId: null,
      visibility: 'public',
      });
      await fs.writeFile(path.join(process.env.UPLOAD_DIR!, `${fileId}.md`), '# x');
      mockDeleteByFilePath.mockResolvedValue(1);

      const first = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${fileId}`,
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