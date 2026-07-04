import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';

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

import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { searchRoutes } from '../../src/routes/search.js';
import { UserStore } from '../../src/services/user-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';

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
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;
  let cookie: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    const users = new UserStore(db);
    const sessions = new AuthSessionStore(db);
    const user = await users.createUser({
      username: 'searcher',
      password: 'searcher-pass-123!',
      role: 'user',
    });
    cookie = `dockhoj_sid=${sessions.create(user.id).id}`;

    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(authPlugin);
    await app.register(searchRoutes);
    await app.ready();
    mockSearchChunks.mockReset();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 400 when "q" is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without a session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=hello' });
    expect(res.statusCode).toBe(401);
  });

  it('returns results with metadata', async () => {
    mockSearchChunks.mockResolvedValueOnce([buildMockHit()]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=hello',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].headingPath).toEqual(['Section']);
    expect(body.results[0].pageNumber).toBe(1);
    expect(body.results[0].blockKind).toBe('paragraph');
    // p4-T11 — viewerId is the requester's id (third arg).
    expect(mockSearchChunks).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), expect.any(String));
  });

  it('passes fileName and fileType as filters to searchChunks', async () => {
    mockSearchChunks.mockResolvedValueOnce([]);

    await app.inject({
      method: 'GET',
      url: '/api/search?q=hello&fileName=notes.md&fileType=.md',
      headers: { cookie },
    });

    const callArgs = mockSearchChunks.mock.calls[0];
    expect(callArgs[1]).toMatchObject({ fileName: 'notes.md', fileType: '.md' });
    // p4-T11 — viewerId is the requester's id.
    expect(typeof callArgs[2]).toBe('string');
  });

  it('passes expand mode through', async () => {
    mockSearchChunks.mockResolvedValueOnce([buildMockHit()]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=hello&expand=sections',
      headers: { cookie },
    });
    expect(res.json().expandMode).toBe('sections');
  });
});

describe('GET /search/rag', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;
  let cookie: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    const users = new UserStore(db);
    const sessions = new AuthSessionStore(db);
    const user = await users.createUser({
      username: 'searcher',
      password: 'searcher-pass-123!',
      role: 'user',
    });
    cookie = `dockhoj_sid=${sessions.create(user.id).id}`;

    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(authPlugin);
    await app.register(searchRoutes);
    await app.ready();
    mockSearchChunks.mockReset();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 400 when "q" is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search/rag',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without a session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search/rag?q=hello' });
    expect(res.statusCode).toBe(401);
  });

  it('returns "no results" when search returns empty', async () => {
    mockSearchChunks.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/search/rag?q=hello',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toContain('No relevant documents');
  });
});