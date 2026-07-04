import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import type Database from 'better-sqlite3';
import { UserStore } from '../services/user-store.js';
import { AuthSessionStore } from '../services/auth-session-store.js';
import { InviteStore } from '../services/invite-store.js';
import { DocumentStore } from '../services/document-store.js';
import { deleteByFilePath } from '../services/qdrant.js';
import { hashPassword } from '../services/password.js';
import { log } from '../utils/logger.js';

type DB = Database.Database;

// p4-T07 / FR-10..19 — /api/admin/* routes. All handlers refuse
// non-admin callers with 403 (the authPlugin already 401s missing
// sessions, so this is a role check, not an auth check).
//
// Self-delete guard (FR-16): an admin cannot DELETE their own user.
// The SPA's AdminUsers page disables the button, but the server is
// the source of truth — 400 if `id === request.user.id`.
//
// Cascade ordering on user delete (FR-16 + design OD-4):
//   1. Read the user's PRIVATE documents via DocumentStore.
//   2. For each: deleteByFilePath from Qdrant → unlink on disk →
//      delete the SQLite row. Qdrant failure aborts; disk ENOENT is
//      tolerated. Order matches `routes/api-documents.ts`.
//   3. DELETE FROM users WHERE id = ?. The FKs handle the rest:
//      auth_sessions → CASCADE, invites.created_by → CASCADE,
//      invites.used_by → SET NULL, documents.owner_id → SET NULL.
//      The last one is what makes the user's PUBLIC-marked files
//      become shared (no app code needed).
//
// Password reset (FR-17): atomic UPDATE users + DELETE FROM
// auth_sessions, wrapped in a single SQLite transaction via
// UserStore.resetPasswordAndRevokeSessions. The user must log in
// again on their next request.

const UPLOAD_DIR = process.env.UPLOAD_DIR || './documents';
const FILE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function isAdminPayload(
  x: unknown,
): x is { id: string; username: string; role: 'admin' | 'user' } {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as { id: unknown }).id === 'string' &&
    typeof (x as { username: unknown }).username === 'string' &&
    ((x as { role: unknown }).role === 'admin' ||
      (x as { role: unknown }).role === 'user')
  );
}

// Returns the narrowed admin user when the caller is one;
// otherwise sends 403 and returns null. Each handler branches on
// `if (!admin) return;`, so the rest of the handler reads with
// `admin.id` properly typed (avoids `request.user!` non-null
// assertions scattered through the file).
function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): { id: string; username: string; role: 'admin' | 'user' } | null {
  if (!isAdminPayload(request.user) || request.user.role !== 'admin') {
    reply.code(403).send({ error: 'Admin required' });
    return null;
  }
  return request.user;
}

// FR-3: at least 12 chars + at least one non-alphanumeric character.
function isValidPassword(plain: unknown): plain is string {
  return typeof plain === 'string' && plain.length >= 12 && /[^A-Za-z0-9]/.test(plain);
}

export const adminRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const db = (fastify as unknown as { db: DB }).db;
  const users = new UserStore(db);
  const sessions = new AuthSessionStore(db);
  const invites = new InviteStore(db);
  const docs = new DocumentStore(db);

  // POST /api/admin/invites — FR-10. Creates an invite and returns
  // the raw token ONCE; the DB stores only its SHA-256 hash.
  fastify.post<{ Body: { expiresInDays?: unknown } }>(
    '/api/admin/invites',
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const expiresInDays =
        typeof (request.body ?? {}).expiresInDays === 'number'
          ? (request.body as { expiresInDays: number }).expiresInDays
          : undefined;
      const invite = invites.create({
        createdBy: admin.id,
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      });
      log.info(
        { event: 'invite_create', inviteId: invite.id, createdBy: admin.id, actorUserId: admin.id },
        'Invite created',
      );
      return { id: invite.id, token: invite.token, expiresAt: invite.expiresAt };
    },
  );

  // GET /api/admin/invites — FR-11. Lists outstanding invites,
  // EXCLUDING the raw token (only the SHA-256 hash survives in the
  // DB; never returned to the admin after creation).
  fastify.get('/api/admin/invites', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    return invites.listOutstanding().map((i) => ({
      id: i.id,
      createdBy: i.createdBy,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      usedBy: i.usedBy,
      usedAt: i.usedAt,
    }));
  });

  // DELETE /api/admin/invites/:id — FR-12. Token is dead immediately.
  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/invites/:id',
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const ok = invites.deleteById(request.params.id);
      if (!ok) return reply.code(404).send({ error: 'Not found' });
      log.info(
        { event: 'invite_revoke', inviteId: request.params.id, actorUserId: admin.id },
        'Invite revoked',
      );
      return { success: true };
    },
  );

  // GET /api/admin/users — FR-15. NFR-1: never include the
  // password_hash column. The mapping below only picks the safe
  // fields; the row is constructed by hand so a future schema
  // drift that added another secret column couldn't leak it.
  fastify.get('/api/admin/users', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    return users.listAll().map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    }));
  });

  // DELETE /api/admin/users/:id — FR-16. Cascade: private docs →
  // chunks + on-disk + SQLite row; public docs → shared via FK
  // SET NULL on user delete. Self-delete is refused with 400.
  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const targetId = request.params.id;
      if (targetId === admin.id) {
        return reply
          .code(400)
          .send({ error: 'Cannot delete your own account' });
      }
      // 404 if the target doesn't exist (same opaque response as
      // "already deleted" — avoids leaking the user list).
      if (!users.findById(targetId)) {
        return reply.code(404).send({ error: 'Not found' });
      }

      // Step 1: enumerate the user's PRIVATE documents and
      // tear them down (Qdrant → disk → SQLite row).
      const privateDocs = docs.findPrivateByOwner(targetId);
      for (const doc of privateDocs) {
        if (!FILE_ID_REGEX.test(doc.fileId)) {
          log.warn({ fileId: doc.fileId }, 'Skipping malformed fileId in cascade');
          continue;
        }
        const ext = path.extname(doc.fileName).toLowerCase();
        const onDiskName = `${doc.fileId}${ext}`;
        const fullPath = path.join(UPLOAD_DIR, onDiskName);
        try {
          await deleteByFilePath(onDiskName);
        } catch (err) {
          log.error({ err, fileId: doc.fileId }, 'Qdrant delete failed in cascade');
          return reply.code(500).send({ error: 'Failed to delete chunks' });
        }
        try {
          await fs.unlink(fullPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            log.warn({ err, fullPath }, 'File unlink failed in cascade (non-fatal)');
          }
        }
        docs.delete(doc.fileId);
      }

      // Step 2: delete the user row. The FKs cascade-handle the
      // rest (sessions, invites.created_by, public-marked files
      // become shared via owner_id SET NULL).
      users.deleteById(targetId);
      log.info(
        {
          event: 'user_delete',
          targetUserId: targetId,
          actorUserId: admin.id,
          documentsDeleted: privateDocs.length,
        },
        'User deleted',
      );
      return { success: true, documentsDeleted: privateDocs.length };
    },
  );

  // POST /api/admin/users/:id/password — FR-17. Atomic hash swap +
  // session revoke. Admin can target their own id (changing their
  // own password is allowed; only delete-self is refused).
  fastify.post<{ Params: { id: string }; Body: { password?: unknown } }>(
    '/api/admin/users/:id/password',
    async (request, reply) => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const targetId = request.params.id;
      const password = (request.body ?? {}).password;
      if (!isValidPassword(password)) {
        return reply
          .code(400)
          .send({ error: 'Password must be at least 12 characters and contain a non-alphanumeric character' });
      }
      if (!users.findById(targetId)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const hash = await hashPassword(password);
      const sessionsRevoked = users.resetPasswordAndRevokeSessions(
        targetId,
        hash,
        (userId) => sessions.deleteByUser(userId),
      );
      log.info(
        {
          event: 'password_reset',
          targetUserId: targetId,
          actorUserId: admin.id,
          sessionsRevoked,
        },
        'Password reset',
      );
      return { success: true };
    },
  );
};
