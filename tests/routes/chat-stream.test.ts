import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';

// Stub the heavy stream-chat pipeline + the title generator BEFORE
// importing the route module so vi.mock can intercept the imports.
vi.mock('../../src/services/stream-chat.js', () => ({
  streamChatCompletion: async function* (
    _params: unknown,
    _signal: AbortSignal
  ): AsyncGenerator<unknown> {
    yield { type: 'sources', sources: [{ id: 'src1', payload: { fileName: 'a.md', filePath: 'a.md', chunk: 'x' }, score: 0.9 }] };
    yield { type: 'token', text: 'Hello ' };
    yield { type: 'token', text: 'world' };
    yield { type: 'done' };
  },
}));

vi.mock('../../src/services/title-generator.js', () => ({
  generateConversationTitle: vi.fn(async () => 'A Title'),
  fallbackTitle: (m: string) => m.slice(0, 60),
}));

import { migrate } from '../../src/db/migrate.js';
import { chatStreamRoutes } from '../../src/routes/chat-stream.js';
import * as titleGen from '../../src/services/title-generator.js';

describe('POST /api/chat/stream', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(chatStreamRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    vi.clearAllMocks();
  });

  it('returns 400 when "q" is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { sessionId: 's' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an invalid sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'hi', sessionId: 'has spaces' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('sets text/event-stream headers on a valid request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'hello world' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('emits the expected event sequence (meta, sources, tokens, done)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'hello world' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    const events: Array<{ event: string; data: unknown }> = [];
    for (const frame of body.split('\n\n')) {
      const trimmed = frame.trim();
      if (!trimmed) continue;
      let event = 'message';
      let data = '';
      for (const line of trimmed.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch {
        // non-json frame — skip
      }
    }
    const eventNames = events.map((e) => e.event);
    expect(eventNames[0]).toBe('meta');
    expect(eventNames).toContain('sources');
    expect(eventNames.filter((n) => n === 'token').length).toBeGreaterThanOrEqual(2);
    expect(eventNames).toContain('done');
    // title is best-effort and arrives AFTER done on the first exchange
    // (per FR-15a). It MUST come last when present.
    const titleIdx = eventNames.indexOf('title');
    const doneIdx = eventNames.indexOf('done');
    if (titleIdx >= 0) {
      expect(titleIdx).toBeGreaterThan(doneIdx);
    }
    // The token events together must sum to "Hello world"
    const tokens = events.filter((e) => e.event === 'token').map((e) => (e.data as { text: string }).text);
    expect(tokens.join('')).toBe('Hello world');
  });
});