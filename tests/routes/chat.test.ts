import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});

import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { chatRoutes } from '../../src/routes/chat.js';

// p2-T08 — chat tests updated to use the new /api/chat path and to
// inject an in-memory SQLite DB (the chat route now requires one
// since persistence moved from the in-memory Map to ConversationStore
// in p2-T06). The /api/chat route exercises the OpenAI SDK; we keep the
// tests scoped to validation + session lifecycle rather than mocking
// the LLM call (p2-p1-T12 covers the streaming path under stubbed streams).

describe('/api/chat', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(chatRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 400 when "q" is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { sessionId: 's1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an invalid sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { q: 'hello', sessionId: 'has spaces and !' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an invalid sessionId on DELETE', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/chat/has spaces',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a valid-but-missing sessionId on DELETE', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/chat/myvalidid',
    });
    expect(res.statusCode).toBe(404);
  });
});