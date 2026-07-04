import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { sessionRoutes } from '../../src/routes/api-sessions.js';
import { UserStore } from '../../src/services/user-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';

// p2-T07 tests — /api/sessions routes via fastify.inject. Each test
// builds a fresh Fastify app bound to an in-memory DB so tests are
// isolated.
//
// Phase 04 / p4-T14 — viewer-scoped: routes register the real
// authPlugin so requests without a valid session cookie get 401, and
// every handler reads/writes only the caller's sessions (FR-42..44).
// Two users + auth cookies are seeded per case so we can assert
// foreign-session invisibility.

describe('/api/sessions routes', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;
  let viewerId: string;
  let viewerCookie: string;
  let otherId: string;
  let otherCookie: string;

  beforeEach(async () => {
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
    otherId = other.id;
    otherCookie = `dockhoj_sid=${sessions.create(otherId).id}`;

    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(sessionRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe('POST /api/sessions', () => {
    it('401 when no session cookie is supplied', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/sessions' });
      expect(res.statusCode).toBe(401);
    });

    it('creates a session, stamps owner_id, returns 201 with id/title/createdAt', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(body.title).toBe('New chat');
      expect(body.ownerId).toBe(viewerId);
      expect(typeof body.createdAt).toBe('string');
    });
  });

  describe('GET /api/sessions', () => {
    it('401 when no session cookie is supplied', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(401);
    });

    it('returns an empty list initially', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ sessions: [] });
    });

    it('returns sessions with messageCount (viewer-scoped)', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      const { id } = JSON.parse(create.body);
      // add a user + assistant message via the store directly
      const storeMod = await import('../../src/services/conversations.js');
      const store = new storeMod.ConversationStore(db);
      store.appendUserMessage(id, 'hi');
      store.appendAssistantMessage(id, 'hello', [
        { fileName: 'a.md', filePath: 'a.md', chunk: 'x', score: 0.9 },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      const body = JSON.parse(res.body);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].messageCount).toBe(2);
      expect(body.sessions[0].ownerId).toBe(viewerId);
    });

    // Phase 04 / p4-T14 / FR-43 — viewer only sees their own sessions.
    it("returns only the viewer's sessions; foreign sessions are invisible", async () => {
      const storeMod = await import('../../src/services/conversations.js');
      const store = new storeMod.ConversationStore(db);
      store.create(viewerId);
      store.create(viewerId);
      store.create(otherId);

      const viewerRes = await app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      expect(viewerRes.json().sessions).toHaveLength(2);

      const otherRes = await app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { cookie: otherCookie },
      });
      expect(otherRes.json().sessions).toHaveLength(1);
    });

    it("user A's session list grows when A creates sessions; user B's doesn't", async () => {
      const before = await app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      expect(before.json().sessions).toHaveLength(0);

      // Viewer creates two sessions.
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });

      const after = await app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      expect(after.json().sessions).toHaveLength(2);

      // Other user's list is unchanged.
      const otherRes = await app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { cookie: otherCookie },
      });
      expect(otherRes.json().sessions).toHaveLength(0);
    });
  });

  describe('GET /api/sessions/:id', () => {
    it('returns the viewer\'s session', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      const { id } = JSON.parse(create.body);

      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}`,
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(id);
      expect(body.ownerId).toBe(viewerId);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/nope',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for an invalid sessionId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/has spaces',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(400);
    });

    // Phase 04 / p4-T14 / FR-44 — opaque 404 for sessions owned by
    // someone else. The endpoint can't be used to enumerate ids.
    it("returns 404 for a session owned by another user (FR-44)", async () => {
      const otherCreate = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: otherCookie },
      });
      const { id } = JSON.parse(otherCreate.body);

      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}`,
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Session not found' });
    });
  });

  describe('GET /api/sessions/:id/messages', () => {
    it('returns messages in chronological order for the viewer\'s session', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      const { id } = JSON.parse(create.body);

      const storeMod = await import('../../src/services/conversations.js');
      const store = new storeMod.ConversationStore(db);
      store.appendUserMessage(id, 'first');
      store.appendAssistantMessage(id, 'second', []);

      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/messages`,
        headers: { cookie: viewerCookie },
      });
      const body = JSON.parse(res.body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
        'first',
        'second',
      ]);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/nope/messages',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    // FR-44 — opaque 404 across user boundaries on the messages path.
    it("returns 404 for a foreign user's messages", async () => {
      const otherCreate = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: otherCookie },
      });
      const { id } = JSON.parse(otherCreate.body);

      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/messages`,
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/sessions/:id', () => {
    it('renames the viewer\'s session and marks title_source = user', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      const { id } = JSON.parse(create.body);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        headers: { cookie: viewerCookie },
        payload: { title: 'My Plan' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.title).toBe('My Plan');
      expect(body.titleSource).toBe('user');
    });

    it('returns 400 for empty title', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      const { id } = JSON.parse(create.body);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        headers: { cookie: viewerCookie },
        payload: { title: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/sessions/nope',
        headers: { cookie: viewerCookie },
        payload: { title: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });

    // FR-44 — PATCH refuses to mutate foreign sessions.
    it("returns 404 for a foreign user's session", async () => {
      const otherCreate = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: otherCookie },
      });
      const { id } = JSON.parse(otherCreate.body);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        headers: { cookie: viewerCookie },
        payload: { title: 'hostile rename' },
      });
      expect(res.statusCode).toBe(404);

      // Title on the other user's session is unchanged.
      const ownerRes = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}`,
        headers: { cookie: otherCookie },
      });
      expect(ownerRes.json().title).toBe('New chat');
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    it('removes the viewer\'s session and its messages (cascade)', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: viewerCookie },
      });
      const { id } = JSON.parse(create.body);
      const storeMod = await import('../../src/services/conversations.js');
      const store = new storeMod.ConversationStore(db);
      store.appendUserMessage(id, 'bye');

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${id}`,
        headers: { cookie: viewerCookie },
      });
      expect(del.statusCode).toBe(204);

      const get = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}`,
        headers: { cookie: viewerCookie },
      });
      expect(get.statusCode).toBe(404);

      // cascade: messages gone (only this session's messages are
      // affected — the FK CASCADE is on conversation_id).
      const remaining = db
        .prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?')
        .get(id) as { c: number };
      expect(remaining.c).toBe(0);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/sessions/nope',
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    // FR-44 — DELETE refuses to remove foreign sessions.
    it("returns 404 for a foreign user's session", async () => {
      const otherCreate = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: otherCookie },
      });
      const { id } = JSON.parse(otherCreate.body);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${id}`,
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(404);

      // The other user's session still exists.
      const ownerRes = await app.inject({
        method: 'GET',
        url: `/api/sessions/${id}`,
        headers: { cookie: otherCookie },
      });
      expect(ownerRes.statusCode).toBe(200);
    });
  });
});
