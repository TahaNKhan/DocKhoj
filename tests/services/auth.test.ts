import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';
import { UserStore } from '../../src/services/user-store.js';

// p4-T05 tests — the session-lookup middleware. Covers FR-20..24:
//   - 401 JSON on missing / malformed / unknown session cookie
//   - /api/health stays public
//   - valid session → request.user populated, last_seen_at advances
//
// Each test wires a tiny Fastify app with an in-memory SQLite DB
// (so the session lookup goes through real migrations + real SQL,
// not a mock — per the project CLAUDE.md §2.0 E2E-first rule).

describe('authPlugin', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;
  let sessions: AuthSessionStore;
  let users: UserStore;
  let userId: string;
  let sessionId: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    users = new UserStore(db);
    sessions = new AuthSessionStore(db);

    const user = await users.createUser({
      username: 'alice',
      password: 'correcthorse123!',
      role: 'admin',
    });
    userId = user.id;
    sessionId = sessions.create(userId).id;

    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;

    // Stand-in for a real protected route. Echoes request.user so the
    // test can assert the decorator was populated.
    app.get('/api/protected', async (request) => ({
      user: request.user ?? null,
    }));

    // Stand-in for /api/health (the real route lives elsewhere; the
    // authPlugin's public exemption logic is what we're verifying
    // here, so the path is the load-bearing detail, not the handler).
    app.get('/api/health', async () => ({ status: 'ok' }));

    // Stand-in for an /api/auth/* endpoint (T6 will mount the real
    // /api/auth/login). The exemption is path-prefix based, not
    // handler based, so any path under /api/auth/ exercises it.
    app.post('/api/auth/login', async () => ({ ok: true }));

    await app.register(authPlugin);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 401 JSON when no cookie is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Authentication required' });
  });

  it('returns 401 JSON when the cookie is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { cookie: 'dockhoj_sid=' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Authentication required' });
  });

  it('returns 401 JSON when the session id does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { cookie: 'dockhoj_sid=does-not-exist' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Authentication required' });
  });

  it('lets /api/health through without a cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('lets /api/health through even when a bogus cookie is set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: 'dockhoj_sid=garbage' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('lets /api/auth/* through without a cookie (public exemption)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login' });
    expect(res.statusCode).toBe(200);
  });

  it('populates request.user from a valid session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { cookie: `dockhoj_sid=${sessionId}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { id: userId, username: 'alice', role: 'admin' },
    });
  });

  it('parses the cookie when other cookies are also present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { cookie: `other=value; dockhoj_sid=${sessionId}; third=1` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('alice');
  });

  it('updates last_seen_at on a successful authenticated request', async () => {
    // SQLite datetime('now') is seconds-precision; cross the boundary.
    await sleep(SECOND);
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { cookie: `dockhoj_sid=${sessionId}` },
    });
    expect(res.statusCode).toBe(200);

    // Read the raw row so we observe the actual stored timestamp,
    // not the post-expiry-filter view.
    const row = db
      .prepare(`SELECT last_seen_at, expires_at FROM auth_sessions WHERE id = ?`)
      .get(sessionId) as { last_seen_at: string; expires_at: string };

    const lastSeen = parseSqliteDateTime(row.last_seen_at);
    const expiresAt = parseSqliteDateTime(row.expires_at);
    const now = new Date();

    // last_seen_at was refreshed by touch() → within the last few
    // seconds, well under a 5s tolerance.
    expect(Math.abs(now.getTime() - lastSeen.getTime())).toBeLessThan(5_000);

    // expires_at advanced to now + 30 days.
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const drift = Math.abs(expiresAt.getTime() - (now.getTime() + thirtyDaysMs));
    expect(drift).toBeLessThan(5_000);
  });

  it('returns 401 when the session has expired', async () => {
    // Manually expire the session by rewriting its expires_at.
    db.prepare(`UPDATE auth_sessions SET expires_at = datetime('now', '-1 hour') WHERE id = ?`)
      .run(sessionId);
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { cookie: `dockhoj_sid=${sessionId}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Authentication required' });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSqliteDateTime(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z');
}

// SQLite's datetime('now') is seconds-precision; tests that need to
// observe a timestamp change must cross a second boundary.
const SECOND = 1100;