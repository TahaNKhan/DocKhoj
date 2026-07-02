import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { sessionRoutes } from '../../src/routes/api-sessions.js';

// p2-T07 tests — /api/sessions routes via fastify.inject. Each test
// builds a fresh Fastify app bound to an in-memory DB so tests are
// isolated.

describe('/api/sessions routes', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
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
    it('creates a session and returns 201 with id/title/createdAt', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/sessions' });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(body.title).toBe('New chat');
      expect(typeof body.createdAt).toBe('string');
    });
  });

  describe('GET /api/sessions', () => {
    it('returns an empty list initially', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ sessions: [] });
    });

    it('returns sessions with messageCount', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/sessions' });
      const { id } = JSON.parse(create.body);
      // add a user + assistant message via the store directly
      const storeMod = await import('../../src/services/conversations.js');
      const store = new storeMod.ConversationStore(db);
      store.appendUserMessage(id, 'hi');
      store.appendAssistantMessage(id, 'hello', [
        { fileName: 'a.md', filePath: 'a.md', chunk: 'x', score: 0.9 },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/sessions' });
      const body = JSON.parse(res.body);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].messageCount).toBe(2);
    });
  });

  describe('GET /api/sessions/:id', () => {
    it('returns the session', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/sessions' });
      const { id } = JSON.parse(create.body);

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(id);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions/nope' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for an invalid sessionId', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions/has spaces' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/sessions/:id/messages', () => {
    it('returns messages in chronological order', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/sessions' });
      const { id } = JSON.parse(create.body);

      const storeMod = await import('../../src/services/conversations.js');
      const store = new storeMod.ConversationStore(db);
      store.appendUserMessage(id, 'first');
      store.appendAssistantMessage(id, 'second', []);

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/messages` });
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
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/sessions/:id', () => {
    it('renames the session and marks title_source = user', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/sessions' });
      const { id } = JSON.parse(create.body);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { title: 'My Plan' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.title).toBe('My Plan');
      expect(body.titleSource).toBe('user');
    });

    it('returns 400 for empty title', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/sessions' });
      const { id } = JSON.parse(create.body);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { title: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/sessions/nope',
        payload: { title: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    it('removes the session and its messages (cascade)', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/sessions' });
      const { id } = JSON.parse(create.body);
      const storeMod = await import('../../src/services/conversations.js');
      const store = new storeMod.ConversationStore(db);
      store.appendUserMessage(id, 'bye');

      const del = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` });
      expect(del.statusCode).toBe(204);

      const get = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });
      expect(get.statusCode).toBe(404);

      // cascade: messages gone
      const remaining = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as {
        c: number;
      };
      expect(remaining.c).toBe(0);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/sessions/nope' });
      expect(res.statusCode).toBe(404);
    });
  });
});