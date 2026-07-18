import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';
import { UserStore, validateUsername } from '../services/user-store.js';
import type { LinkedMethod } from '../services/auth.js';
import { AuthSessionStore } from '../services/auth-session-store.js';
import { InviteStore } from '../services/invite-store.js';
import { verifyPassword } from '../services/password.js';
import {
  COOKIE_NAME,
  setSessionCookieHeader,
  clearSessionCookieHeader,
} from '../services/cookies.js';
import { log } from '../utils/logger.js';
import { loadOidcConfig } from '../services/oidc.js';

// p4-T06: /api/auth/* routes. Implements FR-1 (first-user-is-admin),
// FR-4/5 (login), FR-6 (logout, idempotent), FR-7 (me), FR-13/14
// (invite/accept), and the /api/auth/status helper for the SPA's
// register-page visibility toggle. All routes set/clear the
// `dockhoj_sid` cookie per NFR-2: HttpOnly, SameSite=Lax, Path=/,
// Max-Age=2592000, Secure when NODE_ENV === 'production'.
//
// ponytail: cookie attribute string and COOKIE_NAME used to be inline
// here (4 callers — login/register/logout/invite-accept). Phase-06
// adds OIDC as the 5th caller, crossing the YAGNI threshold — the
// helpers now live in services/cookies.ts so the security contract
// (the attribute set) is owned in one place.

type DB = Database.Database;

// FR-3: at least 12 chars + at least one non-alphanumeric character.
function validatePassword(plain: unknown): plain is string {
  return typeof plain === 'string' && plain.length >= 12 && /[^A-Za-z0-9]/.test(plain);
}

function isUserPayload(
  x: unknown,
): x is { id: string; username: string; role: 'admin' | 'user'; linkedMethods: LinkedMethod[] } {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as { id: unknown }).id === 'string' &&
    typeof (x as { username: unknown }).username === 'string' &&
    ((x as { role: unknown }).role === 'admin' || (x as { role: unknown }).role === 'user')
  );
}

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const db = (fastify as unknown as { db: DB }).db;
  const users = new UserStore(db);
  const sessions = new AuthSessionStore(db);
  const invites = new InviteStore(db);

  // POST /api/auth/register — FR-1. First user only; 403 if any users
  // exist. The created user is 'admin' if first, otherwise this
  // endpoint refuses (T7 adds the invite-based path through
  // /api/auth/invite/accept).
  fastify.post<{ Body: { username?: string; password?: string } }>('/api/auth/register', async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (!validateUsername(username ?? '')) {
      return reply.status(400).send({ error: 'Invalid username' });
    }
    if (!validatePassword(password)) {
      return reply.status(400).send({ error: 'Password must be at least 12 characters and contain a non-alphanumeric character' });
    }
    if (users.usernameExists(username!)) {
      return reply.status(409).send({ error: 'Username already taken' });
    }
    const isFirst = (db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c === 0;
    if (!isFirst) {
      return reply.status(403).send({ error: 'Registration is invite-only' });
    }
    const user = await users.createUser({ username: username!, password, role: 'admin' });
    const session = sessions.create(user.id);
    setSessionCookieHeader(reply, session.id);
    log.info({ userId: user.id, username: user.username, event: 'register' }, 'First user registered as admin');
    return { id: user.id, username: user.username, role: user.role };
  });

  // POST /api/auth/login — FR-4/5. Identical 401 message for bad
  // username vs bad password (no enumeration, per FR-5).
  fastify.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      // Same response as bad creds to avoid leaking the validation rule.
      return reply.status(401).send({ error: 'Invalid username or password' });
    }
    const user = users.findByUsername(username);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.status(401).send({ error: 'Invalid username or password' });
    }
    const session = sessions.create(user.id);
    users.updateLastLogin(user.id);
    setSessionCookieHeader(reply, session.id);
    log.info({ userId: user.id, username: user.username, event: 'login' }, 'User logged in');
    return { id: user.id, username: user.username, role: user.role };
  });

  // POST /api/auth/logout — FR-6. Idempotent: no session row is a
  // successful no-op. Clears the cookie regardless.
  fastify.post('/api/auth/logout', async (request, reply) => {
    const rawCookie = request.headers.cookie;
    if (rawCookie) {
      // Same parsing rule as the authPlugin (kept in sync — there's
      // no @fastify/cookie dep, so the cookie format is parsed by
      // hand on both sides).
      for (const part of rawCookie.split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === COOKIE_NAME) {
          const sid = rest.join('=').trim();
          if (sid) {
            sessions.deleteById(sid);
            log.info({ event: 'logout' }, 'User logged out');
          }
          break;
        }
      }
    }
    clearSessionCookieHeader(reply);
    return { success: true };
  });

  // GET /api/auth/me — FR-7. Returns the current user payload or 401.
  // The authPlugin populates `request.user` from the session cookie.
  fastify.get('/api/auth/me', async (request, reply) => {
    if (!isUserPayload(request.user)) {
      return reply.status(401).send({ error: 'Authentication required' });
    }
    return request.user;
  });

  // GET /api/auth/status — public. Tells the SPA whether to show the
  // first-user registration form (FR-1 toggle) or hide it. Phase 06
  // // adds the `oidc` field so the SPA can render the SSO button
  // without hardcoding config. `enabled` is false when the operator
  // hasn't configured OIDC, so the existing password-flow UI is
  // unchanged by default.
  fastify.get('/api/auth/status', async () => {
    const c = (db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
    const cfg = loadOidcConfig();
    return {
      firstUserAvailable: c === 0,
      oidc: {
        enabled: cfg !== null,
        providerName: cfg?.providerName ?? '',
      },
    };
  });

  // POST /api/auth/invite/accept — FR-13/14. Validates token, creates
  // the user with role='user', marks the invite used, establishes a
  // session. 410 on bad token (missing, used, or expired).
  fastify.post<{ Body: { token?: string; username?: string; password?: string } }>(
    '/api/auth/invite/accept',
    async (request, reply) => {
      const { token, username, password } = request.body ?? {};
      if (typeof token !== 'string' || token.length === 0) {
        return reply.status(410).send({ error: 'Invite expired or already used' });
      }
      if (!validateUsername(username ?? '')) {
        return reply.status(400).send({ error: 'Invalid username' });
      }
      if (!validatePassword(password)) {
        return reply.status(400).send({ error: 'Password must be at least 12 characters and contain a non-alphanumeric character' });
      }
      if (users.usernameExists(username!)) {
        return reply.status(409).send({ error: 'Username already taken' });
      }
      const invite = invites.findByRawToken(token);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const inviteOk =
        invite !== null && invite.usedBy === null && invite.expiresAt > now;
      if (!inviteOk) {
        return reply.status(410).send({ error: 'Invite expired or already used' });
      }
      // markUsed is single-use-guarded via WHERE used_by IS NULL — a
      // race against another concurrent accept call would still leave
      // the second one without a session, which is the desired
      // single-use semantics (FR-14).
      const user = await users.createUser({ username: username!, password, role: 'user' });
      const marked = invites.markUsed(invite.id, user.id);
      if (!marked) {
        // Lost the race. Refuse the user we just created to keep
        // state consistent (orphan user with no invite linkage).
        // ponytail: a transaction would be cleaner, but two users
        // racing on the same token is an extreme edge case — the
        // simplest correct fallback is to clean up.
        users.deleteById(user.id);
        return reply.status(410).send({ error: 'Invite expired or already used' });
      }
      const session = sessions.create(user.id);
      setSessionCookieHeader(reply, session.id);
      log.info({ userId: user.id, username: user.username, event: 'invite_accept', inviteId: invite.id }, 'Invite accepted');
      return { id: user.id, username: user.username, role: user.role };
    },
  );
};