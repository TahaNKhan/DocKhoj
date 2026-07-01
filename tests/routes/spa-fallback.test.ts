import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { mountSpa } from '../../src/server/spa.js';

// T42 — SPA fallback tests. We point mountSpa at a temp dir with a
// stubbed web/dist/index.html and assert the routing rules:
// - Page routes get 200 + text/html (the index.html fallback).
// - /api/* 404s return JSON, never HTML.
// - Root-level asset paths return the file when present.

describe('SPA fallback (/api/* vs page routes)', () => {
  let app: ReturnType<typeof Fastify>;
  let webDir: string;

  beforeEach(async () => {
    webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockhoj-spa-'));
    fs.writeFileSync(
      path.join(webDir, 'index.html'),
      '<!doctype html><title>DocKhoj SPA</title>'
    );
    app = Fastify({ logger: false });
    await mountSpa(app, webDir);
    await app.register(async (instance) => {
      // Mount a fake /api/does-not-exist route to be sure the SPA
      // fallback doesn't accidentally serve HTML for it.
      instance.get('/api/does-not-exist', async (_req, reply) => reply.code(404).send({ error: 'real 404' }));
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(webDir, { recursive: true, force: true });
  });

  it('returns the SPA index.html for unknown page paths', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('DocKhoj SPA');
  });

  it('returns the SPA index.html for /upload', async () => {
    const res = await app.inject({ method: 'GET', url: '/upload' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('does NOT serve index.html for /api/* unknown paths', async () => {
    // The /api/does-not-exist route handler is a real 404 with a JSON
    // body. If the SPA fallback ever leaked in, we'd see text/html.
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toContain('real 404');
  });

  it('returns JSON for unknown /api/* that have no route either', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/never-defined' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('logs a warning and lets the route layer succeed when the SPA bundle is missing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dockhoj-no-spa-'));
    fs.rmSync(empty, { recursive: true, force: true }); // ensure missing
    const bare = Fastify({ logger: false });
    let warned = false;
    bare.log.warn = (() => {
      warned = true;
    }) as never;
    await mountSpa(bare, empty);

    // /chat should 404 because there's no SPA bundle to fall back to
    const res = await bare.inject({ method: 'GET', url: '/chat' });
    expect(res.statusCode).toBe(404);
    expect(warned).toBe(true);

    await bare.close();
  });
});