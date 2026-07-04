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
  // p4-T15: api-status.ts calls buildVisibilityFilter(viewerId) and
  // passes the result to qdrantClient.count as the filter. The
  // vitest mock replaces the whole module, so we have to expose the
  // function explicitly. The unit-test value mirrors the real one
  // — see services/qdrant.ts buildVisibilityFilter for the canonical
  // shape.
  buildVisibilityFilter: (viewerId: string) => ({
    must: [
      {
        should: [
          { key: 'visibility', match: { value: 'public' } },
          { key: 'ownerId', match: { value: viewerId } },
        ],
      },
    ],
  }),
}));

vi.mock('../../src/services/openai-api-wrapper.js', () => ({
  getLlmContextSize: mockGetLlmContextSize,
}));

import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { UserStore } from '../../src/services/user-store.js';
import { DocumentStore } from '../../src/services/document-store.js';
import { statusRoutes } from '../../src/routes/api-status.js';

// p4-T15 — /api/status is now user-scoped. The TopBar pill shows the
// count of chunks + documents the requesting user can see. The test
// wires the real authPlugin so request.user is populated from a
// session cookie (the same middleware path production uses) and
// asserts the right viewerId reaches qdrant.count + DocumentStore.count.

async function mintSessionCookie(
  app: Awaited<ReturnType<typeof Fastify>>,
  db: Database.Database,
  userId: string
): Promise<string> {
  // authPlugin looks up users + sessions from the per-app db. The
  // user row may already have been inserted by the test (e.g. when
  // a file is owned by aliceId and the FK requires the alice row),
  // but it's not always inserted — insert idempotently to be safe.
  db.prepare(
    'INSERT OR IGNORE INTO users (id, username, role, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, userId, 'user', 'scrypt$x', '2026-07-01 10:00:00', null);
  // Insert a session directly so we don't have to run the full
  // /api/auth/login flow in every test. The session row mimics the
  // shape AuthSessionStore.create() produces.
  const sid = 'sid-' + userId;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    'INSERT OR REPLACE INTO auth_sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(sid, userId, now, now, expires);
  return `dockhoj_sid=${sid}`;
}

// insertUser ensures a user row exists in the per-test db (FK source
// for documents.owner_id and auth_sessions.user_id). Idempotent.
function insertUser(db: Database.Database, userId: string) {
  db.prepare(
    'INSERT OR IGNORE INTO users (id, username, role, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, userId, 'user', 'scrypt$x', '2026-07-01 10:00:00', null);
}

describe('GET /api/status', () => {
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    mockIsOllamaAvailable.mockReset();
    mockQdrantClient.count.mockReset();
    mockGetLlmContextSize.mockReset();
    delete process.env.LLM_MODEL;

    // Seed two users. Each test app gets its own copy of these
    // rows because every test instantiates a fresh in-memory DB.
    const seed = new Database(':memory:');
    seed.pragma('foreign_keys = ON');
    migrate(seed);
    const users = new UserStore(seed);
    aliceId = (
      await users.createUser({
        username: 'alice',
        password: 'alice-pass-123!',
        role: 'user',
      })
    ).id;
    bobId = (
      await users.createUser({
        username: 'bob',
        password: 'bob-pass-123!',
        role: 'user',
      })
    ).id;
    seed.close();
  });

  it('returns chunks, documents, ollamaAvailable, llmModel, and llmContextSize', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    mockQdrantClient.count.mockResolvedValueOnce({ count: 298 });
    mockGetLlmContextSize.mockResolvedValueOnce(200_000);

    const app = Fastify();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    insertUser(db, aliceId);
    new DocumentStore(db).insert({
      fileId: 'a',
      fileName: 'a.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 1,
    ownerId: aliceId,
    visibility: 'public',
    });
    app.decorate('db', db);
    await app.register(authPlugin);
    await app.register(statusRoutes);
    const cookie = await mintSessionCookie(app, db, aliceId);
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie },
    });
    if (res.statusCode !== 200) {
      // eslint-disable-next-line no-console
      console.log('status response body:', res.body, 'mock count called with:', mockQdrantClient.count.mock.calls);
    }
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      chunks: 298,
      documents: 1,
      ollamaAvailable: true,
      llmModel: 'gpt-4o',
      llmContextSize: 200_000,
    });
    expect(mockQdrantClient.count).toHaveBeenCalledWith('documents', expect.anything());
    await app.close();
    db.close();
  });

  it('threads viewerId into buildVisibilityFilter when counting chunks', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    mockQdrantClient.count.mockResolvedValueOnce({ count: 42 });
    mockGetLlmContextSize.mockResolvedValueOnce(200_000);

    const app = Fastify();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    app.decorate('db', db);
    await app.register(authPlugin);
    await app.register(statusRoutes);
    const cookie = await mintSessionCookie(app, db, aliceId);
    await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie },
    });
    // The qdrant client received a filter that includes the viewer
    // visibility clause. Pin that a filter arg was passed — Phase 03
    // / pre-T15 used to call count() with no second arg.
    const callArgs = mockQdrantClient.count.mock.calls[0];
    expect(callArgs.length).toBeGreaterThanOrEqual(2);
    expect(callArgs[1]).toBeDefined();
    await app.close();
    db.close();
  });

  it('hides foreign private documents from the documents count', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    mockQdrantClient.count.mockResolvedValueOnce({ count: 0 });
    mockGetLlmContextSize.mockResolvedValueOnce(null);

    const app = Fastify();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    insertUser(db, aliceId);
    insertUser(db, bobId);
    const store = new DocumentStore(db);
    // Alice's private file — Bob must NOT see it.
    store.insert({
      fileId: 'alice-private',
      fileName: 'a.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:00',
      chunkCount: 1,
      ownerId: aliceId,
      visibility: 'private',
    });
    store.insert({
      fileId: 'bob-private',
      fileName: 'b.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:01',
      chunkCount: 1,
      ownerId: bobId,
      visibility: 'private',
    });
    // A public file owned by Alice. Per FR-34, foreign-public rows
    // are NOT in the documents list — they're only surfaced via
    // Qdrant search/chat (FR-32 / FR-38). So the documents count
    // treats this row the same as a private one for list purposes:
    // only its owner (Alice) sees it in /api/documents and in
    // /api/status's documents field.
    store.insert({
      fileId: 'alice-public',
      fileName: 'ap.md',
      fileType: 'md',
      bytes: 1,
      uploadedAt: '2026-07-01 10:00:02',
      chunkCount: 1,
      ownerId: aliceId,
      visibility: 'public',
    });
    app.decorate('db', db);
    await app.register(authPlugin);
    await app.register(statusRoutes);
    // Inject as Bob — Bob sees only his own private (1); Alice's
    // private and public are foreign to him and excluded by FR-34.
    const cookie = await mintSessionCookie(app, db, bobId);
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie },
    });
    expect(res.json().documents).toBe(1);
    // And as Alice — Alice sees both of hers (private + public).
    const aliceCookie = await mintSessionCookie(app, db, aliceId);
    const resAlice = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie: aliceCookie },
    });
    expect(resAlice.json().documents).toBe(2);
    // Crucially: neither sees the other's PRIVATE doc. Direct
    // count confirms.
    expect(new DocumentStore(db).count(bobId)).toBe(1);
    expect(new DocumentStore(db).count(aliceId)).toBe(2);
    // Empty viewerId matches shared only — neither file has
    // owner_id IS NULL, so 0.
    expect(new DocumentStore(db).count('')).toBe(0);
    await app.close();
    db.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    mockIsOllamaAvailable.mockResolvedValueOnce(true);
    mockQdrantClient.count.mockResolvedValueOnce({ count: 0 });
    mockGetLlmContextSize.mockResolvedValueOnce(null);

    const app = Fastify();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    app.decorate('db', db);
    await app.register(authPlugin);
    await app.register(statusRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Authentication required' });
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
    await app.register(authPlugin);
    await app.register(statusRoutes);
    const cookie = await mintSessionCookie(app, db, aliceId);
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie },
    });
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
    await app.register(authPlugin);
    await app.register(statusRoutes);
    const cookie = await mintSessionCookie(app, db, aliceId);
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie },
    });
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
    await app.register(authPlugin);
    await app.register(statusRoutes);
    const cookie = await mintSessionCookie(app, db, aliceId);
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie },
    });
    expect(res.json().llmModel).toBe('claude-3-5-sonnet-latest');
    await app.close();
    db.close();
  });
});
