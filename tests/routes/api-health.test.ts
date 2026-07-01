import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsOllamaAvailable } = vi.hoisted(() => ({
  mockIsOllamaAvailable: vi.fn(),
}));

vi.mock('../../src/services/embed.js', () => ({
  isOllamaAvailable: mockIsOllamaAvailable,
}));

import Fastify from 'fastify';
import { healthRoutes } from '../../src/routes/api-health.js';

describe('GET /api/health', () => {
  beforeEach(() => mockIsOllamaAvailable.mockReset());

  it('returns { status: "ok", ollama: true } when Ollama is reachable', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    const app = Fastify();
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', ollama: true });
    await app.close();
  });

  it('returns { status: "ok", ollama: false } when Ollama is unreachable', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(false);
    const app = Fastify();
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', ollama: false });
    await app.close();
  });
});