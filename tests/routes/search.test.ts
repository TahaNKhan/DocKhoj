import { describe, it, expect, vi } from 'vitest';

const { mockSearchChunks } = vi.hoisted(() => ({
  mockSearchChunks: vi.fn(),
}));

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
});

vi.mock('../../src/services/embed.js', () => ({
  embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  isOllamaAvailable: vi.fn(async () => true),
}));

vi.mock('../../src/services/qdrant.js', () => ({
  initCollection: vi.fn(async () => {}),
  upsertChunks: vi.fn(async () => {}),
  searchChunks: mockSearchChunks,
  expandHits: vi.fn(async (hits: unknown[]) => hits),
}));

vi.mock('openai', () => ({
  default: function () {
    return {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: 'mocked answer' } }],
          })),
        },
      },
    };
  },
}));

import Fastify from 'fastify';
import { searchRoutes } from '../../src/routes/search.js';

function buildMockHit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'h1',
    vector: [],
    payload: {
      chunk: 'sample text',
      fileName: 'doc.md',
      fileType: '.md',
      filePath: 'abc.md',
      chunkIndex: 0,
      totalChunks: 1,
      headingPath: ['Section'],
      pageNumber: 1,
      blockKind: 'paragraph',
      ...overrides,
    },
    score: 0.9,
  };
}

describe('GET /search', () => {
  beforeEach(() => {
    mockSearchChunks.mockReset();
  });

  it('returns 400 when "q" is missing', async () => {
    const app = Fastify();
    await app.register(searchRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/search' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns results with metadata', async () => {
    mockSearchChunks.mockResolvedValueOnce([buildMockHit()]);
    const app = Fastify();
    await app.register(searchRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search?q=hello' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].headingPath).toEqual(['Section']);
    expect(body.results[0].pageNumber).toBe(1);
    expect(body.results[0].blockKind).toBe('paragraph');

    await app.close();
  });

  it('passes fileName and fileType as filters to searchChunks', async () => {
    mockSearchChunks.mockResolvedValueOnce([]);
    const app = Fastify();
    await app.register(searchRoutes);

    await app.inject({
      method: 'GET',
      url: '/api/search?q=hello&fileName=notes.md&fileType=.md',
    });

    const callArgs = mockSearchChunks.mock.calls[0];
    expect(callArgs[1]).toMatchObject({ fileName: 'notes.md', fileType: '.md' });

    await app.close();
  });

  it('passes expand mode through', async () => {
    mockSearchChunks.mockResolvedValueOnce([buildMockHit()]);
    const app = Fastify();
    await app.register(searchRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/search?q=hello&expand=sections' });
    expect(res.json().expandMode).toBe('sections');

    await app.close();
  });
});

describe('GET /search/rag', () => {
  it('returns 400 when "q" is missing', async () => {
    const app = Fastify();
    await app.register(searchRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/search/rag' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns "no results" when search returns empty', async () => {
    mockSearchChunks.mockResolvedValueOnce([]);
    const app = Fastify();
    await app.register(searchRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/search/rag?q=hello' });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toContain('No relevant documents');
    await app.close();
  });
});