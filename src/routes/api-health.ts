import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { isOllamaAvailable } from '../services/embed.js';

// /api/health — moved from /health per FR-1 / FR-52. The Dockerfile
// HEALTHCHECK line targets this path; the docker-compose `ollama`
// service_healthy condition is independent.

export const healthRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/api/health', async () => {
    const ollama = await isOllamaAvailable();
    return { status: 'ok', ollama };
  });
};