import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { downloadRoutes } from '../../src/routes/download.js';

const FILES_DIR = path.join(process.cwd(), '.tmp-download-test');

describe('GET /download/:filename', () => {
  beforeEach(async () => {
    await fs.mkdir(FILES_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(FILES_DIR, { recursive: true, force: true });
  });

  it('returns 404 for traversal attempts', async () => {
    const app = Fastify();
    await app.register(multipart);
    await app.register(downloadRoutes, { filesDir: FILES_DIR });

    const res = await app.inject({ method: 'GET', url: '/api/download/..%2F..%2Fetc%2Fpasswd' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the file with correct content-type for .md', async () => {
    const filename = 'hello.md';
    await fs.writeFile(path.join(FILES_DIR, filename), '# hello');
    const app = Fastify();
    await app.register(multipart);
    await app.register(downloadRoutes, { filesDir: FILES_DIR });

    const res = await app.inject({ method: 'GET', url: `/api/download/${filename}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('# hello');

    await app.close();
  });

  it('returns application/pdf for .pdf', async () => {
    const filename = 'doc.pdf';
    await fs.writeFile(path.join(FILES_DIR, filename), '%PDF-1.4 fake');
    const app = Fastify();
    await app.register(multipart);
    await app.register(downloadRoutes, { filesDir: FILES_DIR });

    const res = await app.inject({ method: 'GET', url: `/api/download/${filename}` });
    expect(res.headers['content-type']).toContain('application/pdf');

    await app.close();
  });

  it('returns the OOXML MIME for .docx', async () => {
    const filename = 'doc.docx';
    await fs.writeFile(path.join(FILES_DIR, filename), 'fake-docx');
    const app = Fastify();
    await app.register(multipart);
    await app.register(downloadRoutes, { filesDir: FILES_DIR });

    const res = await app.inject({ method: 'GET', url: `/api/download/${filename}` });
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    await app.close();
  });

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const filename = 'data.xyz';
    await fs.writeFile(path.join(FILES_DIR, filename), '12345');
    const app = Fastify();
    await app.register(multipart);
    await app.register(downloadRoutes, { filesDir: FILES_DIR });

    const res = await app.inject({ method: 'GET', url: `/api/download/${filename}` });
    expect(res.headers['content-type']).toContain('application/octet-stream');

    await app.close();
  });

  it('returns 404 when the file does not exist', async () => {
    const app = Fastify();
    await app.register(multipart);
    await app.register(downloadRoutes, { filesDir: FILES_DIR });

    const res = await app.inject({ method: 'GET', url: '/api/download/missing.md' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});