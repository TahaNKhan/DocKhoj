import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { accountRoutes } from '../../src/routes/api-account.js';
import {
  setFetchForTesting,
  resetFetchForTesting,
  resetCachesForTesting,
  verifyState,
} from '../../src/services/oidc.js';
import { UserStore } from '../../src/services/user-store.js';
import { UserIdentityStore } from '../../src/services/user-identity-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';

// p7-T03 — /api/account/link/{status,sso/start,sso/unlink} via
// fastify.inject with real SQLite + the real authPlugin. The auth
// middleware gates /api/account/* (it's NOT under /api/auth/*), so we
// mint real sessions and pass dockhoj_sid cookies. The IdP HTTP
// transport is mocked (network boundary per CLAUDE.md §2) — only the
// discovery doc is needed for /start because buildAuthorizeUrl calls
// getDiscovery.

const ISSUER = 'https://idp.example.com';
const DISCOVERY_URL = 'https://idp.example.com/.well-known/openid-configuration';
const CLIENT_ID = 'dockhoj-client';
const CLIENT_SECRET = 'test-client-secret-1234567890';
const APP_BASE_URL = 'https://dockhoj.example.com';
const REDIRECT_URI = `${APP_BASE_URL}/api/auth/oidc/callback`;
const AUTHZ_ENDPOINT = `${ISSUER}/authorize`;

const PASSWORD = 'correcthorse123!';

function setEnv(): void {
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_DISCOVERY_URL = DISCOVERY_URL;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.APP_BASE_URL = APP_BASE_URL;
  process.env.OIDC_ALLOWED_GROUP = '';
  process.env.OIDC_ADMIN_GROUP = '';
}

function unsetEnv(): void {
  for (const k of [
    'OIDC_ENABLED',
    'OIDC_ISSUER',
    'OIDC_DISCOVERY_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'APP_BASE_URL',
    'OIDC_ALLOWED_GROUP',
    'OIDC_ADMIN_GROUP',
  ]) {
    delete process.env[k];
  }
}

/** Minimal fake IdP: only the discovery doc is fetched on /start. */
function installFakeDiscovery(): void {
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === DISCOVERY_URL) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: AUTHZ_ENDPOINT,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not mocked', { status: 599 });
  };
  setFetchForTesting(fetchImpl);
}

describe('/api/account/link/* routes', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof Database>;
  let users: UserStore;
  let identities: UserIdentityStore;
  let sessions: AuthSessionStore;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    users = new UserStore(db);
    identities = new UserIdentityStore(db);
    sessions = new AuthSessionStore(db);

    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(authPlugin);
    await app.register(accountRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    resetFetchForTesting();
    resetCachesForTesting();
    unsetEnv();
  });

  // ── GET /api/account/link/status ────────────────────────────────

  describe('GET /api/account/link/status', () => {
    it('password user with no identity → password.set=true, oidc.linked=false', async () => {
      const u = await users.createUser({ username: 'alice', password: PASSWORD, role: 'admin' });
      const s = sessions.create(u.id);

      const res = await app.inject({
        method: 'GET',
        url: '/api/account/link/status',
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        password: { set: true },
        oidc: { linked: false },
      });
    });

    it('OIDC user (sentinel) with identity row → password.set=false, oidc.linked=true + issuer/linkedAt', async () => {
      const u = await users.createOidcUser({ username: 'bob', role: 'user' });
      identities.link(u.id, ISSUER, 'idp-sub-1');
      const s = sessions.create(u.id);

      const res = await app.inject({
        method: 'GET',
        url: '/api/account/link/status',
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.password).toEqual({ set: false });
      expect(body.oidc.linked).toBe(true);
      expect(body.oidc.issuer).toBe(ISSUER);
      expect(typeof body.oidc.linkedAt).toBe('string');
    });

    it('returns 401 when no session cookie is present', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/account/link/status' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── POST /api/account/link/sso/start ────────────────────────────

  describe('POST /api/account/link/sso/start', () => {
    it('happy path: 200, location matches /authorize, sets dockhoj_oidc cookie carrying mode=link + linkUserId', async () => {
      setEnv();
      installFakeDiscovery();
      const u = await users.createUser({ username: 'alice', password: PASSWORD, role: 'admin' });
      const s = sessions.create(u.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/start',
        payload: { password: PASSWORD },
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.location).toBe('string');
      const url = new URL(body.location as string);
      expect(url.origin + url.pathname).toBe(AUTHZ_ENDPOINT);
      // Standard authorize URL shape.
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('scope')).toBeTruthy();
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('nonce')).toBeTruthy();
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');

      // State cookie present with the right attributes.
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/dockhoj_oidc=/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);

      // Decode the cookie via verifyState: it must carry mode=link
      // pointing at our user.
      const m = cookie.match(/dockhoj_oidc=([^;]+)/);
      expect(m).toBeTruthy();
      const decoded = verifyState(m![1]!, CLIENT_SECRET);
      expect(decoded).not.toBeNull();
      expect(decoded!.mode).toBe('link');
      expect(decoded!.linkUserId).toBe(u.id);
      expect(decoded!.next).toBe('/account');
    });

    it('returns 401 on a wrong password', async () => {
      setEnv();
      installFakeDiscovery();
      const u = await users.createUser({ username: 'alice', password: PASSWORD, role: 'admin' });
      const s = sessions.create(u.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/start',
        payload: { password: 'wrong-password-99!' },
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid password' });
    });

    it('returns 409 when the user already has an identity row', async () => {
      setEnv();
      installFakeDiscovery();
      const u = await users.createUser({ username: 'alice', password: PASSWORD, role: 'admin' });
      identities.link(u.id, ISSUER, 'existing-sub');
      const s = sessions.create(u.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/start',
        payload: { password: PASSWORD },
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Single sign-on already linked' });
    });

    it('returns 400 when the user is a sentinel (OIDC-only) account', async () => {
      setEnv();
      installFakeDiscovery();
      const u = await users.createOidcUser({ username: 'alice', role: 'user' });
      const s = sessions.create(u.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/start',
        payload: { password: PASSWORD },
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Account has no password' });
    });

    it('returns 503 when OIDC is not configured (env unset)', async () => {
      unsetEnv();
      const u = await users.createUser({ username: 'alice', password: PASSWORD, role: 'admin' });
      const s = sessions.create(u.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/start',
        payload: { password: PASSWORD },
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'OIDC not configured' });
    });

    it('returns 401 without a session cookie', async () => {
      setEnv();
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/start',
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── POST /api/account/link/sso/unlink ───────────────────────────

  describe('POST /api/account/link/sso/unlink', () => {
    it('happy path: 200, identity rows deleted, returns linkedMethods=[password]', async () => {
      const u = await users.createUser({ username: 'alice', password: PASSWORD, role: 'admin' });
      identities.link(u.id, ISSUER, 'sub-1');
      identities.link(u.id, 'https://other.example.com', 'sub-2');
      const s = sessions.create(u.id);

      // Precondition: two identity rows exist.
      expect(identities.findByUserId(u.id)).toHaveLength(2);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/unlink',
        payload: { password: PASSWORD },
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ linkedMethods: ['password'] });
      expect(identities.findByUserId(u.id)).toHaveLength(0);
    });

    it('returns 400 when the user is a sentinel (cannot unlink the only login method)', async () => {
      const u = await users.createOidcUser({ username: 'alice', role: 'user' });
      identities.link(u.id, ISSUER, 'sub-1');
      const s = sessions.create(u.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/unlink',
        payload: { password: PASSWORD },
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Account has no password; cannot unlink the only login method',
      });
      // Nothing was deleted.
      expect(identities.findByUserId(u.id)).toHaveLength(1);
    });

    it('returns 401 on a wrong password', async () => {
      const u = await users.createUser({ username: 'alice', password: PASSWORD, role: 'admin' });
      identities.link(u.id, ISSUER, 'sub-1');
      const s = sessions.create(u.id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/unlink',
        payload: { password: 'wrong-password-99!' },
        headers: { cookie: `dockhoj_sid=${s.id}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid password' });
      expect(identities.findByUserId(u.id)).toHaveLength(1);
    });

    it('returns 401 without a session cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/account/link/sso/unlink',
        payload: { password: PASSWORD },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
