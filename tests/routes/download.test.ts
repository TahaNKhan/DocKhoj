import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { downloadRoutes } from '../../src/routes/download.js';
import { DocumentStore } from '../../src/services/document-store.js';
import { UserStore } from '../../src/services/user-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';

// p3-T09 + p4-T10 tests — /api/download/:filename via fastify.inject.
// Covers:
//   - 404 for traversal attempts (unchanged).
//   - 200 with correct content-type for known extensions.
//   - 404 when the file does not exist on disk.
//   - 401 with no session cookie.
//   - p4-T10 / FR-36: 404 when the file's owner is a different user.
//   - p4-T10 / FR-36: 200 for own files and for shared files.

describe('GET /download/:filename', () => {
  let app: ReturnType<typeof Fastify>;
  let tempDir: string;
  let db: ReturnType<typeof Database>;
  let viewerCookie: string;
  let userCookie: string;
  let viewerId: string;
  let userId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockhoj-download-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);

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
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(multipart);
    await app.register(authPlugin);
    await app.register(downloadRoutes, { filesDir: path.join(tempDir, 'documents') });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns 404 for traversal attempts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/download/..%2F..%2Fetc%2Fpasswd',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the file with correct content-type for .md', async () => {
    const filename = 'happy.md';
    await fs.writeFile(path.join(tempDir, 'documents', filename), '# hello');
    new DocumentStore(db).insert({
      fileId: filename.replace(/\.[^.]+$/, ''),
      fileName: filename,
      fileType: 'md',
      bytes: 8,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 1,
      ownerId: viewerId,
      visibility: 'private',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/download/${filename}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('# hello');
  });

  it('returns application/pdf for .pdf', async () => {
    const filename = 'doc.pdf';
    await fs.writeFile(path.join(tempDir, 'documents', filename), '%PDF-1.4 fake');
    new DocumentStore(db).insert({
      fileId: 'doc',
      fileName: filename,
      fileType: 'pdf',
      bytes: 12,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 1,
      ownerId: viewerId,
      visibility: 'private',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/download/${filename}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('returns the OOXML MIME for .docx', async () => {
    const filename = 'doc.docx';
    await fs.writeFile(path.join(tempDir, 'documents', filename), 'fake-docx');
    new DocumentStore(db).insert({
      fileId: 'doc',
      fileName: filename,
      fileType: 'docx',
      bytes: 9,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 1,
      ownerId: viewerId,
      visibility: 'private',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/download/${filename}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const filename = 'data.xyz';
    await fs.writeFile(path.join(tempDir, 'documents', filename), '12345');
    new DocumentStore(db).insert({
      fileId: 'data',
      fileName: filename,
      fileType: 'xyz',
      bytes: 5,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 1,
      ownerId: viewerId,
      visibility: 'private',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/download/${filename}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.headers['content-type']).toContain('application/octet-stream');
  });

  it('returns 404 when the file is not in the documents table at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/download/missing.md',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when no session cookie is supplied', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/download/anything.md' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when the file belongs to another user (FR-36, no enumeration)', async () => {
    const filename = 'foreign.md';
    await fs.writeFile(path.join(tempDir, 'documents', filename), '# foreign');
    new DocumentStore(db).insert({
      fileId: 'foreign',
      fileName: filename,
      fileType: 'md',
      bytes: 9,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 1,
      ownerId: userId,
      visibility: 'private',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/download/${filename}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(404);
    // Disk file untouched.
    await expect(fs.stat(path.join(tempDir, 'documents', filename))).resolves.toBeDefined();
  });

  it('returns 200 for a shared (owner_id IS NULL) file when requested by any user (FR-36)', async () => {
    const filename = 'shared.md';
    await fs.writeFile(path.join(tempDir, 'documents', filename), '# shared');
    new DocumentStore(db).insert({
      fileId: 'shared',
      fileName: filename,
      fileType: 'md',
      bytes: 8,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 1,
      ownerId: null,
      visibility: 'public',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/download/${filename}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# shared');
  });
});
