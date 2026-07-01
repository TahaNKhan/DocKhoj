import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsOllamaAvailable, mockQdrantClient } = vi.hoisted(() => ({
  mockIsOllamaAvailable: vi.fn(),
  mockQdrantClient: { count: vi.fn() },
}));

vi.mock('../../src/services/embed.js', () => ({
  isOllamaAvailable: mockIsOllamaAvailable,
}));

vi.mock('../../src/services/qdrant.js', () => ({
  qdrantClient: mockQdrantClient,
  QDRANT_COLLECTION: 'documents',
}));

import Fastify from 'fastify';
import { statusRoutes } from '../../src/routes/api-status.js';

describe('GET /api/status', () => {
  beforeEach(() => {
    mockIsOllamaAvailable.mockReset();
    mockQdrantClient.count.mockReset();
  });

  it('returns the live chunk count and ollamaAvailable=true', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    mockQdrantClient.count.mockResolvedValueOnce({ count: 298 });

    const app = Fastify();
    await app.register(statusRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ chunks: 298, ollamaAvailable: true });
    expect(mockQdrantClient.count).toHaveBeenCalledWith('documents');
    await app.close();
  });

  it('returns chunks=0 when qdrant.count() throws (Qdrant unreachable)', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(false);
    mockQdrantClient.count.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const app = Fastify();
    await app.register(statusRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ chunks: 0, ollamaAvailable: false });
    await app.close();
  });

  it('falls back to 0 when qdrant returns a result without a count field', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    mockQdrantClient.count.mockResolvedValueOnce({}); // no count key

    const app = Fastify();
    await app.register(statusRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.json()).toEqual({ chunks: 0, ollamaAvailable: true });
    await app.close();
  });
});