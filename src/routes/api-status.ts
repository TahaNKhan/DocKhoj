import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { isOllamaAvailable } from '../services/embed.js';
import { qdrantClient, QDRANT_COLLECTION } from '../services/qdrant.js';
import { getLlmContextSize } from '../services/openai-api-wrapper.js';

// GET /api/status — surface the live system state for the TopBar
// chrome:
//   - chunks:           Qdrant collection chunk count (live)
//   - ollamaAvailable:  live Ollama reachability flag
//   - llmModel:         process-wide LLM_MODEL
//   - llmContextSize:   probed from the chat API at boot (or null if
//                       the provider doesn't expose one and the model
//                       isn't in our known-size table)
//
// The context-size probe is fired-and-forgotten on the first call;
// subsequent calls hit the cached value.

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
    const llmContextSize = await getLlmContextSize();
    return {
      chunks,
      ollamaAvailable,
      llmModel: process.env.LLM_MODEL || 'gpt-4o',
      llmContextSize,
    };
  });
};
