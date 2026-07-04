import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { adminRoutes } from '../../src/routes/api-admin.js';
import { UserStore } from '../../src/services/user-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';
import { InviteStore } from '../../src/services/invite-store.js';
import { DocumentStore } from '../../src/services/document-store.js';
import { verifyPassword } from '../../src/services/password.js';

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

// p4-T07 tests — /api/admin/* routes via fastify.inject with real
// SQLite (in-memory) + the real authPlugin + a mocked qdrant
// deleteByFilePath. Each test sets up an admin + a non-admin user
// (via the same invite/accept path the production routes use) and
// exercises both privilege tiers per route.

describe('/api/admin/* routes', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;
  let tempDir: string;
  let origCwd: string;
  let origUploadDir: string | undefined;
  let adminId: string;
  let adminSessionId: string;
  let userId: string;
  let userSessionId: string;
  let users: UserStore;
  let sessions: AuthSessionStore;
  let invites: InviteStore;
  let docs: DocumentStore;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockhoj-admin-'));
    origCwd = process.cwd();
    process.chdir(tempDir);
    origUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = path.join(tempDir, 'documents');
    await fs.mkdir(process.env.UPLOAD_DIR, { recursive: true });

    users = new UserStore(db);
    sessions = new AuthSessionStore(db);
    invites = new InviteStore(db);
    docs = new DocumentStore(db);

    mockDeleteByFilePath.mockReset();
    mockDeleteByFilePath.mockResolvedValue(0);

    // First registrant becomes admin (matches the production
    // POST /api/auth/register behavior — but done directly via the
    // store to skip the cookie dance for setup).
    const admin = await users.createUser({
      username: 'root',
      password: 'root-pass-123!',
      role: 'admin',
    });
    adminId = admin.id;
    const adminSession = sessions.create(adminId);
    adminSessionId = adminSession.id;

    // Second user, role=user, via invite (also bypasses the cookie
    // dance — minted directly).
    const inv = invites.create({ createdBy: adminId, expiresInDays: 7 });
    const newbie = await users.createUser({
      username: 'alice',
      password: 'alice-pass-123!',
      role: 'user',
    });
    invites.markUsed(inv.id, newbie.id);
    userId = newbie.id;
    const userSession = sessions.create(userId);
    userSessionId = userSession.id;

    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(authPlugin);
    await app.register(adminRoutes);
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

  const adminCookie = () => `dockhoj_sid=${adminSessionId}`;
  const userCookie = () => `dockhoj_sid=${userSessionId}`;

  // Every handler refuses non-admins with 403.
  describe('non-admin guard on every route', () => {
    const cases: Array<{ label: string; run: () => ReturnType<typeof app.inject> }> = [
      {
        label: 'POST /api/admin/invites',
        run: () => app.inject({ method: 'POST', url: '/api/admin/invites', headers: { cookie: userCookie() }, payload: {} }),
      },
      {
        label: 'GET /api/admin/invites',
        run: () => app.inject({ method: 'GET', url: '/api/admin/invites', headers: { cookie: userCookie() } }),
      },
      {
        label: 'DELETE /api/admin/invites/:id',
        run: () =>
          app.inject({
            method: 'DELETE',
            url: '/api/admin/invites/whatever',
            headers: { cookie: userCookie() },
          }),
      },
      {
        label: 'GET /api/admin/users',
        run: () => app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: userCookie() } }),
      },
      {
        label: 'DELETE /api/admin/users/:id',
        run: () =>
          app.inject({
            method: 'DELETE',
            url: `/api/admin/users/${adminId}`,
            headers: { cookie: userCookie() },
          }),
      },
      {
        label: 'POST /api/admin/users/:id/password',
        run: () =>
          app.inject({
            method: 'POST',
            url: `/api/admin/users/${adminId}/password`,
            headers: { cookie: userCookie() },
            payload: { password: 'whatever-pass-123!' },
          }),
      },
    ];

    for (const c of cases) {
      it(`${c.label} → 403 for non-admin`, async () => {
        const res = await c.run();
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'Admin required' });
      });
    }
  });

  describe('POST /api/admin/invites (FR-10)', () => {
    it('creates an invite and returns the token ONCE', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invites',
        headers: { cookie: adminCookie() },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.id).toBe('string');
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(20);
      expect(typeof body.expiresAt).toBe('string');

      // The DB row exists; raw token is not retrievable from it
      // (only the SHA-256 hash). We verify findByRawToken works
      // with the returned token.
      const found = invites.findByRawToken(body.token);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(body.id);
      expect(found!.tokenHash).not.toBe(body.token);
    });

    it('honors expiresInDays', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invites',
        headers: { cookie: adminCookie() },
        payload: { expiresInDays: 1 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const expires = new Date(body.expiresAt.replace(' ', 'T') + 'Z').getTime();
      const now = Date.now();
      // Should be roughly 1 day away (give it a 5s slack for test
      // execution drift + SQLite second-precision).
      expect(expires - now).toBeGreaterThan(23 * 3600 * 1000);
      expect(expires - now).toBeLessThan(25 * 3600 * 1000);
    });
  });

  describe('GET /api/admin/invites (FR-11)', () => {
    it('lists outstanding invites with NO raw token', async () => {
      const a = invites.create({ createdBy: adminId, expiresInDays: 7 });
      invites.create({ createdBy: adminId, expiresInDays: 7 });
      // A consumed invite must NOT appear.
      const used = invites.create({ createdBy: adminId, expiresInDays: 7 });
      invites.markUsed(used.id, userId);
      // An expired invite must NOT appear either.
      const expired = invites.create({ createdBy: adminId, expiresInDays: 7 });
      db.prepare(`UPDATE invites SET expires_at = datetime('now', '-1 day') WHERE id = ?`).run(expired.id);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/invites',
        headers: { cookie: adminCookie() },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = body.map((r: { id: string }) => r.id);
      expect(ids).toContain(a.id);
      expect(ids).not.toContain(used.id);
      expect(ids).not.toContain(expired.id);
      // Raw token must NOT be present, and neither must the token_hash.
      for (const row of body) {
        expect(row).not.toHaveProperty('token');
        expect(row).not.toHaveProperty('tokenHash');
      }
    });
  });

  describe('DELETE /api/admin/invites/:id (FR-12)', () => {
    it('removes the row and the subsequent list omits it', async () => {
      const inv = invites.create({ createdBy: adminId, expiresInDays: 7 });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/invites/${inv.id}`,
        headers: { cookie: adminCookie() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });

      const afterList = await app.inject({
        method: 'GET',
        url: '/api/admin/invites',
        headers: { cookie: adminCookie() },
      });
      const ids = afterList.json().map((r: { id: string }) => r.id);
      expect(ids).not.toContain(inv.id);
    });

    it('404 on unknown id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/admin/invites/does-not-exist',
        headers: { cookie: adminCookie() },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/admin/users (FR-15)', () => {
    it('returns safe fields and never includes password_hash', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/users',
        headers: { cookie: adminCookie() },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(2);
      const result = String(JSON.stringify(body));
      expect(result).not.toMatch(/password[_-]?hash/i);
      expect(result).not.toMatch(/scrypt\$/);
      for (const row of body) {
        expect(row).not.toHaveProperty('passwordHash');
        expect(row).not.toHaveProperty('password_hash');
      }
      // Confirm the expected field set.
      expect(body[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          username: expect.any(String),
          role: expect.stringMatching(/^(admin|user)$/),
          createdAt: expect.any(String),
        }),
      );
    });
  });

  describe('DELETE /api/admin/users/:id (FR-16)', () => {
    it('400 when admin tries to delete themselves', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${adminId}`,
        headers: { cookie: adminCookie() },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Cannot delete your own account' });
    });

    it('404 for an unknown target id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/admin/users/does-not-exist',
        headers: { cookie: adminCookie() },
      });
      expect(res.statusCode).toBe(404);
    });

    it('cascade: private files removed end-to-end; public files become shared', async () => {
      // Seed the target user with one private file + one public
      // file, each backed by an on-disk file and an expected
      // Qdrant delete call.
      const privateFileId = 'private-file-id';
      const publicFileId = 'public-file-id';

      // Seed extra rows directly so we don't need the full upload
      // pipeline. visibility is set via a follow-up UPDATE because
      // the current DocumentStore.insert only knows the legacy
      // DocumentRow shape; the owner_id + visibility fields are
      // migration-006 columns.
      docs.insert({
        fileId: privateFileId,
        fileName: 'private.md',
        fileType: 'md',
        bytes: 10,
        uploadedAt: '2026-07-03 10:00:00',
        chunkCount: 1,
      });
      db.prepare(`UPDATE documents SET owner_id = ?, visibility = 'private' WHERE file_id = ?`).run(userId, privateFileId);

      docs.insert({
        fileId: publicFileId,
        fileName: 'public.md',
        fileType: 'md',
        bytes: 10,
        uploadedAt: '2026-07-03 10:00:01',
        chunkCount: 1,
      });
      db.prepare(`UPDATE documents SET owner_id = ?, visibility = 'public' WHERE file_id = ?`).run(userId, publicFileId);

      // Lay down on-disk files (matching `${fileId}${ext}`).
      const privatePath = path.join(process.env.UPLOAD_DIR!, `${privateFileId}.md`);
      const publicPath = path.join(process.env.UPLOAD_DIR!, `${publicFileId}.md`);
      await fs.writeFile(privatePath, 'private');
      await fs.writeFile(publicPath, 'public');

      // Tell qdrant each file has 2 chunks (any positive number works).
      mockDeleteByFilePath.mockResolvedValue(2);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${userId}`,
        headers: { cookie: adminCookie() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, documentsDeleted: 1 });

      // Qdrant delete called for the on-disk name of the private
      // file (only) — public files survive via the FK SET NULL on
      // user delete.
      expect(mockDeleteByFilePath).toHaveBeenCalledTimes(1);
      expect(mockDeleteByFilePath).toHaveBeenCalledWith(`${privateFileId}.md`);

      // User row gone.
      expect(users.findById(userId)).toBeNull();

      // Private file: SQLite row gone, on-disk file gone.
      expect(docs.get(privateFileId)).toBeNull();
      await expect(fs.stat(privatePath)).rejects.toMatchObject({ code: 'ENOENT' });

      // Public file: SQLite row survives with owner_id = NULL
      // (now in the shared bucket).
      const publicRow = db
        .prepare(`SELECT file_id, owner_id, visibility FROM documents WHERE file_id = ?`)
        .get(publicFileId) as { file_id: string; owner_id: string | null; visibility: string };
      expect(publicRow).toBeDefined();
      expect(publicRow.owner_id).toBeNull();
      expect(publicRow.visibility).toBe('public');

      // Public file's on-disk file survives.
      await expect(fs.stat(publicPath)).resolves.toBeDefined();
    });

    it('revokes all of the user auth_sessions via FK cascade', async () => {
      const target = await users.createUser({
        username: 'doomed',
        password: 'doomed-pass-123!',
        role: 'user',
      });
      sessions.create(target.id);
      sessions.create(target.id);

      const before = (db.prepare(`SELECT COUNT(*) AS c FROM auth_sessions WHERE user_id = ?`).get(target.id) as { c: number }).c;
      expect(before).toBe(2);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${target.id}`,
        headers: { cookie: adminCookie() },
      });
      expect(res.statusCode).toBe(200);

      const after = (db.prepare(`SELECT COUNT(*) AS c FROM auth_sessions WHERE user_id = ?`).get(target.id) as { c: number }).c;
      expect(after).toBe(0);
    });

    it('500 when Qdrant deleteByFilePath fails on a private doc', async () => {
      const privateFileId = 'qdrant-fail';
      docs.insert({
        fileId: privateFileId,
        fileName: 'x.md',
        fileType: 'md',
        bytes: 1,
        uploadedAt: '2026-07-03 10:00:00',
        chunkCount: 1,
      });
      db.prepare(`UPDATE documents SET owner_id = ?, visibility = 'private' WHERE file_id = ?`).run(userId, privateFileId);

      mockDeleteByFilePath.mockRejectedValueOnce(new Error('qdrant down'));

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/users/${userId}`,
        headers: { cookie: adminCookie() },
      });
      expect(res.statusCode).toBe(500);
      // Cascade aborted; user still around.
      expect(users.findById(userId)).not.toBeNull();
    });
  });

  describe('POST /api/admin/users/:id/password (FR-17)', () => {
    it('changes the password, verifies the new hash, and revokes all the user sessions', async () => {
      // Mint a known session for the target so we can verify its
      // deletion.
      const targetSession = sessions.create(userId);
      expect(sessions.findById(targetSession.id)).not.toBeNull();

      const newPassword = 'fresh-pass-456!';
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${userId}/password`,
        headers: { cookie: adminCookie() },
        payload: { password: newPassword },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });

      // Old password no longer works.
      const oldOk = await verifyPassword('alice-pass-123!', users.findById(userId)!.passwordHash);
      expect(oldOk).toBe(false);
      // New password works.
      const newOk = await verifyPassword(newPassword, users.findById(userId)!.passwordHash);
      expect(newOk).toBe(true);

      // Target user's existing session is gone.
      expect(sessions.findById(targetSession.id)).toBeNull();
    });

    it('admin can change their own password', async () => {
      const newPassword = 'rotated-pass-789!';
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${adminId}/password`,
        headers: { cookie: adminCookie() },
        payload: { password: newPassword },
      });
      expect(res.statusCode).toBe(200);
      const ok = await verifyPassword(newPassword, users.findById(adminId)!.passwordHash);
      expect(ok).toBe(true);
    });

    it('400 on invalid password (too short or all-alphanumeric)', async () => {
      const tooShort = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${userId}/password`,
        headers: { cookie: adminCookie() },
        payload: { password: 'short1!' },
      });
      expect(tooShort.statusCode).toBe(400);

      const allAlpha = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${userId}/password`,
        headers: { cookie: adminCookie() },
        payload: { password: 'longenoughbutnonnumeric' },
      });
      expect(allAlpha.statusCode).toBe(400);
    });

    it('404 on unknown user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/users/does-not-exist/password',
        headers: { cookie: adminCookie() },
        payload: { password: 'whatever-pass-123!' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
