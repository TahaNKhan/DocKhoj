import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import path from 'path';
import { fileURLToPath } from 'url';
import { uploadRoutes } from './routes/upload.js';
import { searchRoutes } from './routes/search.js';
import { chatRoutes } from './routes/chat.js';
import { chatStreamRoutes } from './routes/chat-stream.js';
import { downloadRoutes } from './routes/download.js';
import { sessionRoutes } from './routes/api-sessions.js';
import { healthRoutes } from './routes/api-health.js';
import { statusRoutes } from './routes/api-status.js';
import { documentRoutes } from './routes/api-documents.js';
import { initCollection, migratePayloads } from './services/qdrant.js';
import { isOllamaAvailable } from './services/embed.js';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { mountSpa } from './server/spa.js';
import { log } from './utils/logger.js';
import { authPlugin } from './services/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHUTDOWN_TIMEOUT_MS = 30_000;
const WEB_DIST = process.env.WEB_DIST || path.join(__dirname, '..', 'web', 'dist');

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'production' ? undefined : {
        target: 'pino-pretty',
        options: {
          translateTime: 'YYYY-MM-DD HH:mm:ss.SSS',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  fastify.addHook('onRequest', async (request) => {
    if (request.url === '/api/health' || request.url.startsWith('/static')) return;
    log.info({ method: request.method, url: request.url }, 'Incoming request');
  });

  fastify.addHook('onResponse', async (request, reply) => {
    if (request.url === '/api/health' || request.url.startsWith('/static')) return;
    log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed'
    );
  });

  await fastify.register(cors, { origin: true });
  await fastify.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 100 },
  });

  // Mount the SPA (web/dist/). Must run before the routes so the static
  // plugin handles asset requests and the SPA fallback handler is
  // installed before any route plugin can claim "/{page}" patterns.
  await mountSpa(fastify, WEB_DIST);

  // Decorate the Fastify instance with the SQLite DB singleton BEFORE
  // any route plugin that depends on it (chat, chat-stream,
  // sessions) registers. Order matters — encapsulated children only
  // see decorations made on the parent before they're registered.
  fastify.decorate('db', openDb());

  // p4-T05 / FR-20: session middleware. Registered before every
  // /api/* route plugin so request.user is populated before any
  // handler runs. The plugin itself exempts /api/auth/* and
  // /api/health internally.
  await fastify.register(authPlugin);

  await fastify.register(uploadRoutes);
  await fastify.register(searchRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(chatStreamRoutes);
  await fastify.register(downloadRoutes);

  // SQLite-backed sessions routes. The sessionId regex (^[A-Za-z0-9_-]{1,64}$)
  // is enforced both here and at the ConversationStore layer for defense
  // in depth.
  await fastify.register(sessionRoutes);

  // /api/health (moved from /health per FR-1 / FR-52).
  await fastify.register(healthRoutes);

  // /api/status — live chunk count + Ollama reachability for the
  // TopBar chrome.
  await fastify.register(statusRoutes);

  // Phase 03 / p3-T02 — documents list + delete endpoints.
  await fastify.register(documentRoutes);

  return fastify;
}

let shuttingDown = false;

async function shutdown(server: Awaited<ReturnType<typeof buildApp>>, signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'Shutdown signal received');

  const timeout = setTimeout(() => {
    log.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  try {
    await server.close();
    log.info('Server closed cleanly');
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'Error during shutdown');
    clearTimeout(timeout);
    process.exit(1);
  }
}

async function start() {
  try {
    // SQLite migrations first — sessions routes (p2-T07) and any future
    // schema-dependent routes both need the schema applied. Run before
    // initCollection so a fresh volume doesn't end up with a Qdrant
    // collection pointing at a SQLite that hasn't been migrated.
    const db = openDb();
    const result = migrate(db);
    log.info({ applied: result.applied, total: result.total }, 'Migrations done');

    await initCollection();

    // Phase 04 / p4-T03 / FR-31 — one-shot Qdrant payload backfill
    // (ownerId + visibility on legacy chunks). Gated by an
    // app_metadata flag; idempotent on re-run. Runs after
    // initCollection so the indexes + metadata collection exist.
    const migration = await migratePayloads();
    log.info(migration, 'Qdrant payload migration result');

    const ollamaReady = await isOllamaAvailable();
    log.info({ ollamaReady }, 'Ollama reachability');

    log.info({ ollamaUrl: process.env.OLLAMA_BASE_URL }, 'Starting server');

    const fastify = await buildApp();
    const port = parseInt(process.env.PORT || '3001');
    await fastify.listen({ port, host: '0.0.0.0' });
    log.info({ port, url: `http://localhost:${port}` }, 'Server running');

    process.on('SIGTERM', () => shutdown(fastify, 'SIGTERM'));
    process.on('SIGINT', () => shutdown(fastify, 'SIGINT'));
  } catch (err) {
    log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  start();
}

export { start };