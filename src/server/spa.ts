import path from 'node:path';
import fs from 'node:fs';
import mime from 'mime-types';
import type { FastifyInstance } from 'fastify';

// mountSpa — wires the Vite-built SPA bundle into the Fastify app.
//
// Phase 02 architecture (per design.md §Architecture overview):
// - The single Fastify process serves the SPA static (web/dist/),
//   all /api/* routes, and the SPA fallback for unknown page paths.
// - /api/* MUST NOT be served by the SPA fallback (per FR-4):
//   unknown /api/* paths return a real 404 JSON, never HTML.
// - Page paths (`/chat`, `/upload`, anything else non-/api/*) fall
//   through to index.html so the client-side router can take over.
//
// We hand-roll the static serving rather than using @fastify/static
// because that plugin 404s on missing files and never lets the SPA
// fallback handler run. We want: file exists → serve it; file
// missing → serve index.html.

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(filePath: string): string {
  const known = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  if (known) return known;
  const looked = mime.lookup(filePath);
  return (looked as string | false) || 'application/octet-stream';
}

export async function mountSpa(fastify: FastifyInstance, webDistPath: string) {
  const resolved = path.isAbsolute(webDistPath)
    ? webDistPath
    : path.resolve(process.cwd(), webDistPath);

  if (!fs.existsSync(path.join(resolved, 'index.html'))) {
    fastify.log.warn(
      { webDistPath: resolved },
      'SPA bundle not found — /chat and /upload will 404. Run `npm run build:web`.'
    );
    fastify.setNotFoundHandler((request, reply) => {
      return reply.code(404).send({ error: 'Not found' });
    });
    return;
  }

  // Catch-all GET handler. Serves static files when they exist,
  // otherwise falls back to index.html for client-side routing.
  // /api/* is excluded because those are real JSON endpoints with
  // their own routes (this handler shouldn't match them anyway
  // since /api/* is registered first, but defense-in-depth).
  fastify.get('/*', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const url = request.url.split('?')[0] ?? '/';
    const rel = url === '/' ? '/index.html' : url;
    const filePath = path.join(resolved, rel);
    // Path-traversal guard: the resolved file must stay inside the
    // web/dist directory.
    const rootWithSep = resolved + path.sep;
    if (!filePath.startsWith(rootWithSep) && filePath !== path.join(resolved, 'index.html')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      reply.type(mimeFor(filePath));
      return reply.send(fs.readFileSync(filePath));
    }
    // Fallback: serve index.html so the SPA router can take over.
    reply.type('text/html; charset=utf-8');
    return reply.send(fs.readFileSync(path.join(resolved, 'index.html')));
  });

  fastify.log.info({ webDistPath: resolved }, 'SPA bundle mounted');

  // /api/* unknown paths return JSON 404, not HTML.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (request.method !== 'GET') {
      return reply.code(404).send({ error: 'Not found' });
    }
    // Should be caught by /* above, but guard anyway.
    reply.type('text/html; charset=utf-8');
    return reply.send(fs.readFileSync(path.join(resolved, 'index.html')));
  });
}