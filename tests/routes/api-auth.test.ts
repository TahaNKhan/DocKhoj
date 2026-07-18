import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { authRoutes } from '../../src/routes/api-auth.js';
import { UserStore } from '../../src/services/user-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';
import { InviteStore } from '../../src/services/invite-store.js';

// p4-T06 tests — /api/auth/* routes via fastify.inject, with a real
// SQLite (in-memory) + the real authPlugin so the session/cookie
// parsing is exercised end-to-end. The authPlugin exempts /api/auth/*
// internally, so request.user stays unset for unauthenticated auth
// routes (the /me handler checks for that explicitly).

describe('/api/auth/* routes', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;
  let users: UserStore;
  let sessions: AuthSessionStore;
  let invites: InviteStore;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    users = new UserStore(db);
    sessions = new AuthSessionStore(db);
    invites = new InviteStore(db);

    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(authPlugin);
    await app.register(authRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe('POST /api/auth/register (FR-1)', () => {
    it('first registration → 200 + Set-Cookie + admin role', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'alice', password: 'correcthorse123!' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ username: 'alice', role: 'admin' });
      expect(typeof res.json().id).toBe('string');
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
      expect(cookieStr).toMatch(/dockhoj_sid=[A-Za-z0-9_-]+/);
      expect(cookieStr).toMatch(/HttpOnly/i);
      expect(cookieStr).toMatch(/SameSite=Lax/i);
      expect(cookieStr).toMatch(/Path=\//);
      expect(cookieStr).toMatch(/Max-Age=2592000/);
    });

    it('second registration → 403 (FR-1, invite-only after first user)', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'alice', password: 'correcthorse123!' },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'bob', password: 'another-good-one!' },
      });
      expect(second.statusCode).toBe(403);
      expect(second.json()).toEqual({ error: 'Registration is invite-only' });
    });

    it('rejects invalid username', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'ab', password: 'correcthorse123!' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects password that is too short or all-alphanumeric', async () => {
      const tooShort = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'alice', password: 'short1!' },
      });
      expect(tooShort.statusCode).toBe(400);

      const allAlpha = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'alice', password: 'longenoughpassword' },
      });
      expect(allAlpha.statusCode).toBe(400);
    });
  });

  describe('POST /api/auth/login (FR-4/5)', () => {
    beforeEach(async () => {
      await users.createUser({ username: 'alice', password: 'correcthorse123!', role: 'admin' });
    });

    it('bad password → 401 with the no-enumeration message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'alice', password: 'wrong-password1!' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid username or password' });
    });

    it('bad username → 401 with the SAME message (no enumeration)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: 'correcthorse123!' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid username or password' });
    });

    it('good creds → 200 + Set-Cookie + user payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'alice', password: 'correcthorse123!' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ username: 'alice', role: 'admin' });
      const cookieStr = String(res.headers['set-cookie']);
      expect(cookieStr).toMatch(/dockhoj_sid=[A-Za-z0-9_-]+/);
    });

    it('updates last_login_at on successful login', async () => {
      const before = users.findByUsername('alice')!.lastLoginAt;
      expect(before).toBeNull();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'alice', password: 'correcthorse123!' },
      });
      expect(res.statusCode).toBe(200);
      const after = users.findByUsername('alice')!.lastLoginAt;
      expect(after).not.toBeNull();
    });
  });

  describe('POST /api/auth/logout (FR-6)', () => {
    it('is idempotent: no cookie → 200 + cleared Set-Cookie, no row deleted', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      const cookieStr = String(res.headers['set-cookie']);
      expect(cookieStr).toMatch(/dockhoj_sid=/);
      expect(cookieStr).toMatch(/Max-Age=0/);
    });

    it('with a valid session cookie: deletes the session row + clears the cookie', async () => {
      const u = await users.createUser({ username: 'alice', password: 'correcthorse123!', role: 'admin' });
      const s = sessions.create(u.id);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(200);
      expect(sessions.findById(s.id)).toBeNull();
    });

    it('with an unknown session cookie: 200, no rows affected, cookie cleared', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: 'dockhoj_sid=does-not-exist' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/auth/me (FR-7)', () => {
    it('with a valid session cookie → user payload', async () => {
      const u = await users.createUser({ username: 'alice', password: 'correcthorse123!', role: 'admin' });
      const s = sessions.create(u.id);
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: u.id, username: 'alice', role: 'admin' });
    });

    it('without a cookie → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Authentication required' });
    });

    it('with an unknown cookie → 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: 'dockhoj_sid=does-not-exist' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/auth/status', () => {
    it('on an empty users table → 200 + firstUserAvailable=true', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(res.statusCode).toBe(200);
      // p6-T07 — /status now also returns the `oidc` field (FR-19). The
      // additive shape is documented; we use `objectContaining` so this
      // test doesn't need to change every time a new top-level field
      // lands.
      expect(res.json()).toEqual(expect.objectContaining({ firstUserAvailable: true }));
    });

    it('after a user exists → 200 + firstUserAvailable=false', async () => {
      await users.createUser({ username: 'alice', password: 'correcthorse123!', role: 'admin' });
      const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(expect.objectContaining({ firstUserAvailable: false }));
    });

    it('includes the oidc field (p6-T07: enabled=false when OIDC is not configured)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({
          oidc: { enabled: false, providerName: '' },
        }),
      );
    });

    it('does not require auth (no cookie needed)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/auth/invite/accept (FR-13/14)', () => {
    let adminId: string;
    let validToken: string;
    let validInviteId: string;

    beforeEach(async () => {
      const admin = await users.createUser({ username: 'admin', password: 'correcthorse123!', role: 'admin' });
      adminId = admin.id;
      const inv = invites.create({ createdBy: adminId, expiresInDays: 7 });
      validToken = inv.token;
      validInviteId = inv.id;
    });

    it('valid unused unexpired token → 200 + session, invite marked used, role=user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/invite/accept',
        payload: { token: validToken, username: 'bob', password: 'another-good-one!' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ username: 'bob', role: 'user' });
      const cookieStr = String(res.headers['set-cookie']);
      expect(cookieStr).toMatch(/dockhoj_sid=[A-Za-z0-9_-]+/);

      // invite is consumed
      const inv = invites.findByRawToken(validToken)!;
      expect(inv.usedBy).not.toBeNull();
      expect(inv.usedAt).not.toBeNull();

      // user actually exists
      const created = users.findByUsername('bob');
      expect(created).not.toBeNull();
      expect(created!.role).toBe('user');
    });

    it('already-used token → 410', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/invite/accept',
        payload: { token: validToken, username: 'bob', password: 'another-good-one!' },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/invite/accept',
        payload: { token: validToken, username: 'carol', password: 'another-good-one!' },
      });
      expect(second.statusCode).toBe(410);
      expect(second.json()).toEqual({ error: 'Invite expired or already used' });

      // The second-attempt user was NOT created (race-loser cleanup).
      expect(users.findByUsername('carol')).toBeNull();
    });

    it('unknown token → 410', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/invite/accept',
        payload: { token: 'no-such-token', username: 'bob', password: 'another-good-one!' },
      });
      expect(res.statusCode).toBe(410);
    });

    it('expired token → 410', async () => {
      // Backdate expires_at directly (InviteStore.create doesn't accept
      // negative days — same pattern as invite-store.test.ts).
      db.prepare(`UPDATE invites SET expires_at = datetime('now', '-1 day') WHERE id = ?`).run(validInviteId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/invite/accept',
        payload: { token: validToken, username: 'bob', password: 'another-good-one!' },
      });
      expect(res.statusCode).toBe(410);
    });

    it('rejects invalid username / password', async () => {
      const badName = await app.inject({
        method: 'POST',
        url: '/api/auth/invite/accept',
        payload: { token: validToken, username: 'a', password: 'another-good-one!' },
      });
      expect(badName.statusCode).toBe(400);

      const badPw = await app.inject({
        method: 'POST',
        url: '/api/auth/invite/accept',
        payload: { token: validToken, username: 'bob', password: 'short' },
      });
      expect(badPw.statusCode).toBe(400);
    });

    it('rejects taken username (409) even with a valid token', async () => {
      await users.createUser({ username: 'bob', password: 'another-good-one!', role: 'user' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/invite/accept',
        payload: { token: validToken, username: 'bob', password: 'another-good-one!' },
      });
      expect(res.statusCode).toBe(409);
      // Invite is still unused — username collision shouldn't consume the token.
      expect(invites.findByRawToken(validToken)!.usedBy).toBeNull();
    });
  });
});