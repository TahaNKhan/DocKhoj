import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const { mockEmbedTexts, mockInitCollection, mockUpsertChunks } = vi.hoisted(() => ({
  mockEmbedTexts: vi.fn(),
  mockInitCollection: vi.fn(async () => {}),
  mockUpsertChunks: vi.fn(async () => {}),
}));

vi.mock('../../src/services/embed.js', () => ({
  embedText: vi.fn(async () => [0.1, 0.2]),
  embedTexts: mockEmbedTexts,
  isOllamaAvailable: vi.fn(async () => true),
}));

vi.mock('../../src/services/qdrant.js', () => ({
  initCollection: mockInitCollection,
  upsertChunks: mockUpsertChunks,
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

let TEMP_DIR: string;
let ORIGINAL_CWD: string;

function fakeMultipart(filename: string, content: string) {
  const boundary = '----test123';
  const body =
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

describe('POST /upload', () => {
  let db: ReturnType<typeof Database>;
  beforeEach(async () => {
    TEMP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'dockhoj-test-'));
    ORIGINAL_CWD = process.cwd();
    process.chdir(TEMP_DIR);
    mockEmbedTexts.mockReset();
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2], [0.3, 0.4]]);
    mockUpsertChunks.mockClear();
    // Phase 03 / p3-T01: the upload route now writes a row in the
    // `documents` table after a successful index. Spin up an
    // in-memory DB so each test is hermetic.
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
  });

  afterEach(async () => {
    db.close();
    process.chdir(ORIGINAL_CWD);
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
  });

  it('returns 400 when no file is included', async () => {
    const app = Fastify();
    app.decorate('db', db);
    await app.register(multipart);
    await app.register(uploadRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      payload: Buffer.from('--x--\r\n'),
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('indexes an uploaded markdown file', async () => {
    const app = Fastify();
    app.decorate('db', db);
    await app.register(multipart);
    await app.register(uploadRoutes);

    const md = '# Hello\n\nWorld.';
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      ...fakeMultipart('test.md', md),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.chunksIndexed).toBeGreaterThanOrEqual(1);
    expect(mockUpsertChunks).toHaveBeenCalled();

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