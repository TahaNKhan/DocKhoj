import { FastifyInstance } from 'fastify';
import { embedText } from '../services/embed.js';
import { searchChunks } from '../services/qdrant.js';
import { chatWithDocuments } from '../services/openai-api-wrapper.js';
import { searchLog as log } from '../utils/logger.js';

export async function searchRoutes(fastify: FastifyInstance) {
  fastify.get('/search', async (request, reply) => {
    const { q, limit } = request.query as { q?: string; limit?: string };

    if (!q) {
      return reply.status(400).send({ error: 'Query parameter "q" is required' });
    }

    const limitNum = Math.min(parseInt(limit || '5'), 20);

    try {
      log.debug({ queryLength: q.length, limit: limitNum }, 'Processing search');
      const queryVector = await embedText(q);
      const results = await searchChunks(queryVector, { limit: limitNum });

      log.info({ resultCount: results.length }, 'Search complete');
      return {
        query: q,
        results: results.map((r) => ({
          id: r.id,
          text: r.payload.chunk,
          fileName: r.payload.fileName,
          fileType: r.payload.fileType,
          filePath: r.payload.filePath,
          chunkIndex: r.payload.chunkIndex,
          totalChunks: r.payload.totalChunks,
          score: r.score,
        })),
      };
    } catch (error) {
      log.error({ error }, 'Search error');
      return reply.status(500).send({ error: 'Search failed' });
    }
  });

  fastify.get('/search/rag', async (request, reply) => {
    const { q, limit } = request.query as { q?: string; limit?: string };

    if (!q) {
      return reply.status(400).send({ error: 'Query parameter "q" is required' });
    }

    const limitNum = Math.min(parseInt(limit || '5'), 20);

    try {
      log.debug({ queryLength: q.length, limit: limitNum }, 'Processing RAG search');
      const queryVector = await embedText(q);
      const results = await searchChunks(queryVector, { limit: limitNum });

      if (results.length === 0) {
        log.info('No relevant documents found for RAG search');
        return {
          answer: 'No relevant documents found for your query.',
          sources: [],
        };
      }

      const contextChunks = results.map((r) => ({
        fileName: r.payload.fileName,
        chunk: r.payload.chunk,
        filePath: r.payload.filePath,
        score: r.score ?? 0,
      }));

      const response = await chatWithDocuments(q, contextChunks);
      log.info({ answerLength: response.answer.length }, 'RAG search complete');

      return {
        answer: response.answer,
        sources: response.sources,
      };
    } catch (error) {
      log.error({ error }, 'RAG search error');
      return reply.status(500).send({ error: 'RAG search failed' });
    }
  });
}