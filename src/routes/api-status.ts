import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { isOllamaAvailable } from '../services/embed.js';
import { qdrantClient, QDRANT_COLLECTION } from '../services/qdrant.js';

// GET /api/status — surface the live system state for the TopBar
// chrome. `chunks` is the Qdrant collection's chunk count;
// `ollamaAvailable` is the live Ollama reachability flag.

export const statusRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/api/status', async () => {
    const ollamaAvailable = await isOllamaAvailable();
    let chunks = 0;
    try {
      const result = await qdrantClient.count(QDRANT_COLLECTION);
      chunks = result.count ?? 0;
    } catch {
      // Qdrant unreachable — leave chunks at 0.
    }
    return { chunks, ollamaAvailable };
  });
};