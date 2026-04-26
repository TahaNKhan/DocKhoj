import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { uploadRoutes } from './routes/upload.js';
import { searchRoutes } from './routes/search.js';
import { chatRoutes } from './routes/chat.js';
import { initCollection } from './services/qdrant.js';
import { log } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'YYYY-MM-DD HH:mm:ss.SSS',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  fastify.addHook('onRequest', async (request, reply) => {
    log.info({
      method: request.method,
      url: request.url,
    }, 'Incoming request');
  });

  fastify.addHook('onResponse', async (request, reply) => {
    log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    }, 'Request completed');
  });

  await fastify.register(cors, { origin: true });
  await fastify.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  const publicPath = path.join(__dirname, '..', 'public');
  await fastify.register(fastifyStatic, {
    root: publicPath,
    prefix: '/',
  });

  await fastify.register(uploadRoutes);
  await fastify.register(searchRoutes);
  await fastify.register(chatRoutes);

  fastify.get('/health', async () => ({ status: 'ok' }));

  return fastify;
}

async function start() {
  try {
    await initCollection();

    log.info({ ollamaUrl: process.env.OLLAMA_BASE_URL }, 'Starting server');

    const fastify = await buildApp();
    const port = parseInt(process.env.PORT || '3000');
    await fastify.listen({ port, host: '0.0.0.0' });
    log.info({ port, url: `http://localhost:${port}` }, 'Server running');
  } catch (err) {
    log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();