import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { uploadRoutes } from './routes/upload.js';
import { searchRoutes } from './routes/search.js';
import { chatRoutes } from './routes/chat.js';
import { downloadRoutes } from './routes/download.js';
import { initCollection } from './services/qdrant.js';
import { isOllamaAvailable } from './services/embed.js';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { log } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHUTDOWN_TIMEOUT_MS = 30_000;

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
    if (request.url === '/health' || request.url.startsWith('/static')) return;
    log.info({ method: request.method, url: request.url }, 'Incoming request');
  });

  fastify.addHook('onResponse', async (request, reply) => {
    if (request.url === '/health' || request.url.startsWith('/static')) return;
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

  const publicPath = path.join(__dirname, '..', 'public');
  await fastify.register(fastifyStatic, {
    root: publicPath,
    prefix: '/',
  });

  await fastify.register(uploadRoutes);
  await fastify.register(searchRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(downloadRoutes);

  fastify.get('/health', async () => {
    const ollama = await isOllamaAvailable();
    return { status: 'ok', ollama };
  });

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
    // SQLite migrations first — sessions routes (T28) and the upload
    // progress bus (T35) both need the schema. Run before initCollection
    // so a fresh volume doesn't end up with a Qdrant collection pointing
    // at a SQLite that hasn't been migrated.
    const db = openDb();
    const result = migrate(db);
    log.info({ applied: result.applied, total: result.total }, 'Migrations done');

    await initCollection();

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