import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsOllamaAvailable, mockQdrantClient, mockGetLlmContextSize } = vi.hoisted(() => ({
  mockIsOllamaAvailable: vi.fn(),
  mockQdrantClient: { count: vi.fn() },
  mockGetLlmContextSize: vi.fn(),
}));

vi.mock('../../src/services/embed.js', () => ({
  isOllamaAvailable: mockIsOllamaAvailable,
}));

vi.mock('../../src/services/qdrant.js', () => ({
  qdrantClient: mockQdrantClient,
  QDRANT_COLLECTION: 'documents',
}));

vi.mock('../../src/services/openai-api-wrapper.js', () => ({
  getLlmContextSize: mockGetLlmContextSize,
}));

import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { DocumentStore } from '../../src/services/document-store.js';
import { statusRoutes } from '../../src/routes/api-status.js';

describe('GET /api/status', () => {
  beforeEach(() => {
    mockIsOllamaAvailable.mockReset();
    mockQdrantClient.count.mockReset();
    mockGetLlmContextSize.mockReset();
    delete process.env.LLM_MODEL;
  });

  it('returns chunks, documents, ollamaAvailable, llmModel, and llmContextSize', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    mockQdrantClient.count.mockResolvedValueOnce({ count: 298 });
    mockGetLlmContextSize.mockResolvedValueOnce(200_000);

    const app = Fastify();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    new DocumentStore(db).insert({
      fileId: 'a',
      fileName: 'a.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 1,
    });
    app.decorate('db', db);
    await app.register(statusRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      chunks: 298,
      documents: 1,
      ollamaAvailable: true,
      llmModel: 'gpt-4o',
      llmContextSize: 200_000,
    });
    expect(mockQdrantClient.count).toHaveBeenCalledWith('documents');
    await app.close();
    db.close();
  });

  it('returns chunks=0 when qdrant.count() throws (Qdrant unreachable)', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(false);
    mockQdrantClient.count.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    mockGetLlmContextSize.mockResolvedValueOnce(null);

    const app = Fastify();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    app.decorate('db', db);
    await app.register(statusRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.json()).toEqual({
      chunks: 0,
      documents: 0,
      ollamaAvailable: false,
      llmModel: 'gpt-4o',
      llmContextSize: null,
    });
    await app.close();
    db.close();
  });

  it('falls back to 0 when qdrant returns a result without a count field', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    mockQdrantClient.count.mockResolvedValueOnce({}); // no count key
    mockGetLlmContextSize.mockResolvedValueOnce(8192);

    const app = Fastify();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    app.decorate('db', db);
    await app.register(statusRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.json()).toEqual({
      chunks: 0,
      documents: 0,
      ollamaAvailable: true,
      llmModel: 'gpt-4o',
      llmContextSize: 8192,
    });
    await app.close();
    db.close();
  });

  it('honors LLM_MODEL env when reporting the model name', async () => {
    process.env.LLM_MODEL = 'claude-3-5-sonnet-latest';
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    mockQdrantClient.count.mockResolvedValueOnce({ count: 42 });
    mockGetLlmContextSize.mockResolvedValueOnce(200_000);

    const app = Fastify();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    app.decorate('db', db);
    await app.register(statusRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.json().llmModel).toBe('claude-3-5-sonnet-latest');
    await app.close();
    db.close();
  });
});
