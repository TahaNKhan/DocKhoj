import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const {
  mockEmbedTexts,
  mockInitCollection,
  mockUpsertChunks,
  mockSetOwnerVisibility,
} = vi.hoisted(() => ({
  mockEmbedTexts: vi.fn(),
  mockInitCollection: vi.fn(async () => {}),
  mockUpsertChunks: vi.fn(async () => {}),
  mockSetOwnerVisibility: vi.fn(async () => {}),
}));

vi.mock('../../src/services/embed.js', () => ({
  embedText: vi.fn(async () => [0.1, 0.2]),
  embedTexts: mockEmbedTexts,
  isOllamaAvailable: vi.fn(async () => true),
}));

vi.mock('../../src/services/qdrant.js', () => ({
  initCollection: mockInitCollection,
  upsertChunks: mockUpsertChunks,
  // Phase 04 / p4-T09 — add setOwnerVisibility to the mock so
  // upload route handlers don't try to reach a real Qdrant.
  setOwnerVisibility: mockSetOwnerVisibility,
  searchChunks: vi.fn(async () => []),
  expandHits: vi.fn(async (hits: unknown[]) => hits),
}));

vi.mock('openai', () => ({
  default: function () {
    return {
      chat: {
        completions: {
          create: vi.fn(async () => ({ choices: [{ message: { content: 'mocked' } }] })),
        },
      },
    };
  },
}));

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { uploadRoutes } from '../../src/routes/upload.js';
import { authPlugin } from '../../src/services/auth.js';
import { UserStore } from '../../src/services/user-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';

let TEMP_DIR: string;
let ORIGINAL_CWD: string;

function fakeMultipart(filename: string, content: string, fields?: Record<string, string>) {
  const boundary = '----test123';
  let body = '';
  // Phase 04 / p4-T09 — value fields BEFORE the file part so
  // the busboy-based parser finalizes the fields map before the
  // file stream is consumed (per @fastify/multipart README).
  for (const [name, value] of Object.entries(fields ?? {})) {
    body +=
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      value +
      `\r\n`;
  }
  body +=
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/markdown\r\n\r\n` +
    content +
    `\r\n--${boundary}--\r\n`;

  return {
    payload: Buffer.from(body),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// Phase 04 / p4-T09 — Hermetic auth setup. We register the real
// authPlugin so the upload route's `request.user` contract holds,
// then insert a user + session directly (skipping scrypt) and
// return a cookie to attach to inject calls.
async function setupAuth(db: ReturnType<typeof Database>): Promise<{ cookie: string; userId: string; username: string }> {
  const userId = 'test-user-id';
  const username = 'alice';
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`,
  ).run(userId, username, 'scrypt$16384$8$1$dummy$dummy', 'user');
  const session = new AuthSessionStore(db).create(userId);
  return { cookie: `dockhoj_sid=${session.id}`, userId, username };
}

describe('POST /upload', () => {
  let db: ReturnType<typeof Database>;
  let cookie: string;
  let userId: string;
  let username: string;

  beforeEach(async () => {
    TEMP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'dockhoj-test-'));
    ORIGINAL_CWD = process.cwd();
    process.chdir(TEMP_DIR);
    mockEmbedTexts.mockReset();
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2], [0.3, 0.4]]);
    mockUpsertChunks.mockClear();
    mockSetOwnerVisibility.mockClear();
    // Phase 03 / p3-T01: the upload route now writes a row in the
    // `documents` table after a successful index. Spin up an
    // in-memory DB so each test is hermetic.
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    const auth = await setupAuth(db);
    cookie = auth.cookie;
    userId = auth.userId;
    username = auth.username;
  });

  afterEach(async () => {
    db.close();
    process.chdir(ORIGINAL_CWD);
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
  });

  async function buildApp() {
    const app = Fastify({ logger: false });
    app.decorate('db', db);
    await app.register(multipart);
    await app.register(authPlugin);
    await app.register(uploadRoutes);
    await app.ready();
    return app;
  }

  it('returns 400 when no file is included', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { cookie, 'content-type': 'multipart/form-data; boundary=x' },
      payload: Buffer.from('--x--\r\n'),
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('returns 401 without a session cookie', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      ...fakeMultipart('test.md', '# Hello\n\nWorld.'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Authentication required' });

    await app.close();
  });

  it('indexes an uploaded markdown file (visibility defaults to private)', async () => {
    const app = await buildApp();

    const md = '# Hello\n\nWorld.';
    const mp = fakeMultipart('test.md', md);
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.chunksIndexed).toBeGreaterThanOrEqual(1);
    expect(body.fileId).toBeDefined();
    expect(body.ownerUsername).toBe(username);
    expect(body.visibility).toBe('private');
    expect(mockUpsertChunks).toHaveBeenCalled();
    // Phase 04 / p4-T09 — setOwnerVisibility called with the
    // on-disk basename (fileId + ext), requester's user id, and
    // the resolved visibility.
    expect(mockSetOwnerVisibility).toHaveBeenCalledTimes(1);
    const [onDiskBasename, ownerIdArg, visibilityArg] =
      mockSetOwnerVisibility.mock.calls[0] as [string, string, string];
    expect(ownerIdArg).toBe(userId);
    expect(visibilityArg).toBe('private');
    expect(onDiskBasename.endsWith('.md')).toBe(true);

    // SQLite row: owner_id + visibility are stamped.
    const row = db
      .prepare(`SELECT owner_id, visibility FROM documents WHERE file_id = ?`)
      .get(body.fileId) as { owner_id: string; visibility: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.owner_id).toBe(userId);
    expect(row!.visibility).toBe('private');

    await app.close();
  });

  it('accepts visibility=public', async () => {
    const app = await buildApp();

    const mp = fakeMultipart('public.md', '# Public\n\nShared.', { visibility: 'public' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.visibility).toBe('public');
    expect(body.ownerUsername).toBe(username);

    expect(mockSetOwnerVisibility).toHaveBeenCalledWith(
      expect.stringMatching(/\.md$/),
      userId,
      'public',
    );

    const row = db
      .prepare(`SELECT owner_id, visibility FROM documents WHERE file_id = ?`)
      .get(body.fileId) as { owner_id: string; visibility: string } | undefined;
    expect(row!.owner_id).toBe(userId);
    expect(row!.visibility).toBe('public');

    await app.close();
  });

  it('accepts visibility=private (explicit)', async () => {
    const app = await buildApp();

    const mp = fakeMultipart('priv.md', '# Private', { visibility: 'private' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.visibility).toBe('private');

    await app.close();
  });

  it('returns 400 for visibility=foo', async () => {
    const app = await buildApp();

    const mp = fakeMultipart('bad.md', '# Bad', { visibility: 'foo' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { cookie, ...mp.headers },
      payload: mp.payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/visibility/i);
    // Nothing reached Qdrant or SQLite — short-circuit before
    // save/parse/index.
    expect(mockUpsertChunks).not.toHaveBeenCalled();
    expect(mockSetOwnerVisibility).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM documents`).get()).toEqual({ c: 0 });

    await app.close();
  });
});

describe('GET /files', () => {
  let db: ReturnType<typeof Database>;
  beforeEach(async () => {
    TEMP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'dockhoj-test-'));
    ORIGINAL_CWD = process.cwd();
    process.chdir(TEMP_DIR);
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(async () => {
    db.close();
    process.chdir(ORIGINAL_CWD);
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
  });

  it('lists files in the documents directory', async () => {
    const app = Fastify();
    app.decorate('db', db);
    await app.register(multipart);
    await app.register(uploadRoutes);

    await fs.writeFile(path.join(TEMP_DIR, 'documents', 'a.md'), '# a');

    const res = await app.inject({ method: 'GET', url: '/api/files' });
    expect(res.statusCode).toBe(200);
    const files = res.json();
    expect(files.some((f: { filePath: string }) => f.filePath === 'a.md')).toBe(true);

    await app.close();
  });
});