import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import fp from 'fastify-plugin';
import { AuthSessionStore } from './auth-session-store.js';
import { UserStore, OIDC_PASSWORD_SENTINEL } from './user-store.js';

export type LinkedMethod = 'password' | 'oidc';

// p4-T05: session lookup middleware.
//
// Per FR-20..24: every /api/* except /api/auth/* and /api/health
// requires a valid session. On a hit, the middleware populates
// request.user = { id, username, role } and refreshes the session's
// rolling expiry. On a miss, the request is short-circuited with
// 401 JSON.
//
// Per FR-25: SPA page routes (/chat, /upload, /login, …) are NOT
// gated — they're served by the SPA fallback (src/server/spa.ts)
// which returns index.html so the client-side RouteGuard can
// redirect unauthenticated users to /login?next=… . Only /api/* is
// the trust boundary that requires a session.
//
// The cookie name is fixed (`dockhoj_sid`) per design.md §"API
// surface". We parse it from the raw Cookie header — no
// @fastify/cookie dependency (the SPA is same-origin so the cookie
// set/clear path lives in the auth routes, not here).

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; username: string; role: 'admin' | 'user'; linkedMethods: LinkedMethod[] };
  }
}

const SESSION_COOKIE = 'dockhoj_sid';

function isPublic(url: string): boolean {
  // SPA page routes are publicly served; index.html lets the client
  // router handle auth UX. /api/* (except /api/auth/* + /api/health)
  // is the only path that requires a session (FR-20..25).
  return !url.startsWith('/api/')
      || url === '/api/health'
      || url.startsWith('/api/auth/');
}

function parseCookieSid(rawCookieHeader: string | undefined): string | null {
  if (!rawCookieHeader) return null;
  // Cookie format: 'a=1; b=2'. Split on '; ', trim, match on name.
  for (const part of rawCookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=').trim();
      return value || null;
    }
  }
  return null;
}

export const authPlugin: FastifyPluginAsync = fp(async (fastify: FastifyInstance) => {
  const db = (fastify as unknown as { db: Database.Database }).db;
  const sessions = new AuthSessionStore(db);
  const users = new UserStore(db);
  // p7-T04: one indexed SELECT to know whether this user has any OIDC
  // identity row. Prepared once at plugin boot, reused on every request.
  // why: instantiating a UserIdentityStore just for this boolean would
  // cross a module boundary for one query; the prepared statement is the
  // smaller diff and matches the "index-lookup on user_id" shape.
  const hasIdentity = db.prepare(
    `SELECT 1 AS x FROM user_identities WHERE user_id = ? LIMIT 1`,
  );

  fastify.addHook('onRequest', async (request: FastifyRequest, reply) => {
    // Always attempt to populate request.user from the cookie if a
    // valid session is present — even on public paths like /api/auth/me
    // (p4-T06: GET /me should return the user when a valid cookie
    // exists, 401 otherwise). The "401 if no session" gate only
    // applies to protected paths.
    const sid = parseCookieSid(request.headers.cookie);
    if (sid) {
      const session = sessions.findById(sid);
      if (session) {
        const user = users.findById(session.userId);
        if (user) {
          // p7-T04: linkedMethods — additive field consumed by /me and
          // (later) the account-linking UI. 'password' iff the hash
          // isn't the OIDC sentinel; 'oidc' iff any identity row exists.
          const linkedMethods: LinkedMethod[] = [];
          if (user.passwordHash !== OIDC_PASSWORD_SENTINEL) linkedMethods.push('password');
          if (hasIdentity.get(user.id) !== undefined) linkedMethods.push('oidc');
          request.user = {
            id: user.id,
            username: user.username,
            role: user.role,
            linkedMethods,
          };
          // Rolling-window refresh; fire-and-forget — a touch() failure
          // shouldn't take down the request.
          sessions.touch(sid);
        }
      }
    }

    if (isPublic(request.url)) return;

    if (!request.user) {
      reply.code(401).send({ error: 'Authentication required' });
      return reply;
    }
  });
});