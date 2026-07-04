import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';

// p4-T11 / FR-38 — search endpoints thread request.user.id as the
// viewerId so user B never sees user A's private chunks. The route
// tests assert (a) the right viewerId reaches searchChunks /
// expandHits, (b) the mock's visibility behaviour is what the
// client experiences end-to-end.

// Mutable per-test visibility flag — when `false`, alice's chunks
// are private; when `true`, they're flipped to public. The mock
// below mimics the real Qdrant visibility filter so a test can
// prove "bob sees 0 hits while alice's file is private" and "bob
// sees the hits once alice flips the file to public".
const { mockSearchChunks, mockExpandHits, mockChatWithDocuments } = vi.hoisted(() => ({
  mockSearchChunks: vi.fn(),
  mockExpandHits: vi.fn(),
  mockChatWithDocuments: vi.fn(),
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
  expandHits: mockExpandHits,
}));

vi.mock('../../src/services/openai-api-wrapper.js', () => ({
  chatWithDocuments: mockChatWithDocuments,
}));

import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { searchRoutes } from '../../src/routes/search.js';
import { UserStore } from '../../src/services/user-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';

// The shared visibility state — toggled by `flipAliceFileToPublic()`.
// In production Qdrant would do this; here we drive the mock to match.
let aliceFileIsPublic = false;

function alicePrivateChunk() {
  return {
    id: 'alice-secret-1',
    vector: [],
    payload: {
      chunk: 'a-unique-marker-that-only-appears-in-alice-file',
      fileName: 'alice-secret.md',
      fileType: '.md',
      filePath: 'alice-secret.md',
      chunkIndex: 0,
      totalChunks: 1,
      headingPath: ['Section'],
      pageNumber: 1,
    },
    score: 0.95,
  };
}

// Mock qdrant.searchChunks — applies a buildVisibilityFilter-shaped
// gate: return alice's chunk only when the viewer is alice OR the
// chunk's visibility was flipped to public. This mirrors the
// real Qdrant behavior at the route-test layer so the assertions
// exercise the full chain (route → mock → response shape).
function setupSearchChunksMock(aliceId: string) {
  mockSearchChunks.mockImplementation(
    async (_vector: unknown, _opts: unknown, viewerId?: string) => {
      if (!viewerId) return [];
      if (aliceFileIsPublic) return [alicePrivateChunk()];
      // Private visibility — only alice sees it.
      return viewerId === aliceId ? [alicePrivateChunk()] : [];
    }
  );
  // expandHits is a passthrough for these tests; the visibility
  // gate lives in searchChunks.
  mockExpandHits.mockImplementation(async (hits: unknown) => hits);
  // Mirror the real chatWithDocuments: derive `sources` from the
  // context chunks so the /api/search/rag response shape matches
  // what production would return.
  mockChatWithDocuments.mockImplementation(
    async (_q: string, contextChunks: Array<{ fileName: string; chunk: string; filePath: string; score?: number }>) => ({
      answer: 'mocked answer',
      sources: contextChunks.map((c) => ({
        fileName: c.fileName,
        text: c.chunk.slice(0, 200),
        filePath: c.filePath,
        score: c.score,
      })),
    })
  );
}

function flipAliceFileToPublic() {
  aliceFileIsPublic = true;
}

describe('GET /api/search — cross-user visibility (p4-T11 / FR-38)', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;
  let aliceId: string;
  let aliceCookie: string;
  let bobCookie: string;

  beforeEach(async () => {
    aliceFileIsPublic = false;
    mockSearchChunks.mockReset();
    mockExpandHits.mockReset();
    mockChatWithDocuments.mockReset();

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    const users = new UserStore(db);
    const sessions = new AuthSessionStore(db);
    const alice = await users.createUser({
      username: 'alice',
      password: 'alice-pass-123!',
      role: 'user',
    });
    const bob = await users.createUser({
      username: 'bob',
      password: 'bob-pass-123!',
      role: 'user',
    });
    aliceId = alice.id;
    aliceCookie = `dockhoj_sid=${sessions.create(aliceId).id}`;
    bobCookie = `dockhoj_sid=${sessions.create(bob.id).id}`;

    setupSearchChunksMock(aliceId);

    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(authPlugin);
    await app.register(searchRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("passes alice.id as viewerId to searchChunks when alice searches", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=hello',
      headers: { cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(mockSearchChunks).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), aliceId);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].fileName).toBe('alice-secret.md');
  });

  it("passes bob.id as viewerId to searchChunks when bob searches", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=hello',
      headers: { cookie: bobCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(mockSearchChunks).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), expect.not.stringContaining(aliceId));
    // bob is a different user — explicit second arg check.
    const bobCallArgs = mockSearchChunks.mock.calls.find((_args, idx) => {
      // The third call (bob's request) — find by checking the viewerId arg.
      return _args[2] !== aliceId && typeof _args[2] === 'string';
    });
    expect(bobCallArgs).toBeDefined();
    expect(bobCallArgs![2]).not.toBe(aliceId);
  });

  it("as user B, searching for terms in A's private file returns zero hits (FR-38)", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=marker',
      headers: { cookie: bobCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(0);
    // Bob's request must have called searchChunks with bob's id,
    // not alice's — the visibility gate is exercised per-request.
    const lastCall = mockSearchChunks.mock.calls[mockSearchChunks.mock.calls.length - 1];
    expect(lastCall[2]).not.toBe(aliceId);
  });

  it("as user B, the same search returns hits after A flips the file to public", async () => {
    // First request — bob sees nothing (file is private).
    const before = await app.inject({
      method: 'GET',
      url: '/api/search?q=marker',
      headers: { cookie: bobCookie },
    });
    expect(before.json().results).toHaveLength(0);

    flipAliceFileToPublic();
    setupSearchChunksMock(aliceId);

    const after = await app.inject({
      method: 'GET',
      url: '/api/search?q=marker',
      headers: { cookie: bobCookie },
    });
    expect(after.statusCode).toBe(200);
    const body = after.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].fileName).toBe('alice-secret.md');
  });

  it('401 with no session cookie (regression — auth still gates /api/search)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=hello' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/search/rag — cross-user visibility (p4-T11 / FR-38)', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;
  let aliceId: string;
  let aliceCookie: string;
  let bobCookie: string;

  beforeEach(async () => {
    aliceFileIsPublic = false;
    mockSearchChunks.mockReset();
    mockExpandHits.mockReset();
    mockChatWithDocuments.mockReset();

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    const users = new UserStore(db);
    const sessions = new AuthSessionStore(db);
    const alice = await users.createUser({
      username: 'alice',
      password: 'alice-pass-123!',
      role: 'user',
    });
    const bob = await users.createUser({
      username: 'bob',
      password: 'bob-pass-123!',
      role: 'user',
    });
    aliceId = alice.id;
    aliceCookie = `dockhoj_sid=${sessions.create(aliceId).id}`;
    bobCookie = `dockhoj_sid=${sessions.create(bob.id).id}`;

    setupSearchChunksMock(aliceId);

    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(authPlugin);
    await app.register(searchRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('as bob, rag search of A private file returns the no-results answer (FR-38)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search/rag?q=marker',
      headers: { cookie: bobCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toEqual([]);
    expect(body.answer).toContain('No relevant documents');
    // chatWithDocuments MUST NOT have been called — there's
    // nothing to ground the answer in.
    expect(mockChatWithDocuments).not.toHaveBeenCalled();
  });

  it('as alice, rag search of A private file returns hits + an answer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search/rag?q=marker',
      headers: { cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toHaveLength(1);
    expect(mockChatWithDocuments).toHaveBeenCalledTimes(1);
  });

  it('as bob, rag search returns an answer after A flips the file to public', async () => {
    flipAliceFileToPublic();
    setupSearchChunksMock(aliceId);

    const res = await app.inject({
      method: 'GET',
      url: '/api/search/rag?q=marker',
      headers: { cookie: bobCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].fileName).toBe('alice-secret.md');
    expect(mockChatWithDocuments).toHaveBeenCalledTimes(1);
  });
});