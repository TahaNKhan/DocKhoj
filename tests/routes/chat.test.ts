import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});

import Fastify from 'fastify';
import { chatRoutes } from '../../src/routes/chat.js';

describe('POST /chat', () => {
  it('returns 400 when "q" is missing', async () => {
    const app = Fastify();
    await app.register(chatRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { sessionId: 's1' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('returns 400 for an invalid sessionId', async () => {
    const app = Fastify();
    await app.register(chatRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { q: 'hello', sessionId: 'has spaces and !' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('accepts a valid sessionId', async () => {
    const app = Fastify();
    await app.register(chatRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { q: 'hello world', sessionId: 'valid-id_123' },
    });
    expect(res.statusCode).not.toBe(400);

    await app.close();
  });
});

describe('DELETE /chat/:sessionId', () => {
  it('returns 400 for invalid sessionId', async () => {
    const app = Fastify();
    await app.register(chatRoutes);

    const res = await app.inject({
      method: 'DELETE',
      url: '/chat/has spaces',
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('clears a valid session', async () => {
    const app = Fastify();
    await app.register(chatRoutes);

    const res = await app.inject({
      method: 'DELETE',
      url: '/chat/myvalidid',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, sessionId: 'myvalidid' });

    await app.close();
  });
});