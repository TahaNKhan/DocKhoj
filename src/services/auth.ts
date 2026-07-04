import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import fp from 'fastify-plugin';
import { AuthSessionStore } from './auth-session-store.js';
import { UserStore } from './user-store.js';

// p4-T05: session lookup middleware.
//
// Per FR-20..24: every /api/* except /api/auth/* and /api/health
// requires a valid session. On a hit, the middleware populates
// request.user = { id, username, role } and refreshes the session's
// rolling expiry. On a miss, the request is short-circuited with
// 401 JSON.
//
// The cookie name is fixed (`dockhoj_sid`) per design.md §"API
// surface". We parse it from the raw Cookie header — no
// @fastify/cookie dependency (the SPA is same-origin so the cookie
// set/clear path lives in the auth routes, not here).

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; username: string; role: 'admin' | 'user' };
  }
}

const SESSION_COOKIE = 'dockhoj_sid';

function isPublic(url: string): boolean {
  return url === '/api/health' || url.startsWith('/api/auth/');
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

  fastify.addHook('onRequest', async (request: FastifyRequest, reply) => {
    if (isPublic(request.url)) return;

    const sid = parseCookieSid(request.headers.cookie);
    if (!sid) {
      reply.code(401).send({ error: 'Authentication required' });
      return reply;
    }

    const session = sessions.findById(sid);
    if (!session) {
      reply.code(401).send({ error: 'Authentication required' });
      return reply;
    }

    const user = users.findById(session.userId);
    if (!user) {
      // FK target vanished (e.g. user deleted between create + lookup)
      // — treat as no session.
      reply.code(401).send({ error: 'Authentication required' });
      return reply;
    }

    request.user = { id: user.id, username: user.username, role: user.role };
    // Rolling-window refresh; fire-and-forget — a touch() failure
    // shouldn't take down the request.
    sessions.touch(sid);
  });
});