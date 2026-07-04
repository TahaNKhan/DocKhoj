import { FastifyInstance } from 'fastify';
import { embedText } from '../services/embed.js';
import { searchChunks, expandHits, type ExpandMode, type DocumentChunk } from '../services/qdrant.js';
import { chatWithDocuments } from '../services/openai-api-wrapper.js';
import { searchLog as log } from '../utils/logger.js';

function parseExpandMode(value: string | undefined): ExpandMode {
  if (value === 'siblings' || value === 'sections') return value;
  return 'none';
}

function mapHitForResponse(hit: DocumentChunk) {
  return {
    id: hit.id,
    text: hit.payload.chunk,
    fileName: hit.payload.fileName,
    fileType: hit.payload.fileType,
    filePath: hit.payload.filePath,
    chunkIndex: hit.payload.chunkIndex,
    totalChunks: hit.payload.totalChunks,
    headingPath: hit.payload.headingPath ?? [],
    pageNumber: hit.payload.pageNumber,
    blockKind: hit.payload.blockKind,
    score: hit.score,
  };
}

export async function searchRoutes(fastify: FastifyInstance) {
  fastify.get('/api/search', async (request, reply) => {
    const { q, limit, fileName, fileType, expand } = request.query as {
      q?: string;
      limit?: string;
      fileName?: string;
      fileType?: string;
      expand?: string;
    };

    if (!q) {
      return reply.status(400).send({ error: 'Query parameter "q" is required' });
    }

    const limitNum = Math.min(parseInt(limit || '5') || 5, 20);
    const expandMode = parseExpandMode(expand);

    try {
      log.debug({ queryLength: q.length, limit: limitNum, expandMode }, 'Processing search');
      const queryVector = await embedText(q);
      // Phase 04 / p4-T11 / FR-38 — scope retrieval to the requester.
      // buildVisibilityFilter lives inside qdrant.ts; passing
      // request.user.id narrows the result set so other users'
      // private files never surface here.
      const baseResults = await searchChunks(queryVector, {
        limit: limitNum,
        fileName,
        fileType,
      }, request.user.id);
      const results = await expandHits(baseResults, { mode: expandMode }, request.user.id);

      log.info({ resultCount: results.length }, 'Search complete');
      return {
        query: q,
        results: results.map(mapHitForResponse),
        expandMode,
      };
    } catch (error) {
      log.error({ error }, 'Search error');
      return reply.status(500).send({ error: 'Search failed' });
    }
  });

  fastify.get('/api/search/rag', async (request, reply) => {
    const { q, limit, fileName, fileType, expand } = request.query as {
      q?: string;
      limit?: string;
      fileName?: string;
      fileType?: string;
      expand?: string;
    };

    if (!q) {
      return reply.status(400).send({ error: 'Query parameter "q" is required' });
    }

    const limitNum = Math.min(parseInt(limit || '5') || 5, 20);
    const expandMode = parseExpandMode(expand);

    try {
      log.debug({ queryLength: q.length, limit: limitNum, expandMode }, 'Processing RAG search');
      const queryVector = await embedText(q);
      // Phase 04 / p4-T11 / FR-38 — see search() above for the
      // viewerId rationale.
      const baseResults = await searchChunks(queryVector, {
        limit: limitNum,
        fileName,
        fileType,
      }, request.user.id);
      const results = await expandHits(baseResults, { mode: expandMode }, request.user.id);

      if (results.length === 0) {
        log.info('No relevant documents found for RAG search');
        return {
          answer: 'No relevant documents found for your query.',
          sources: [],
          expandMode,
        };
      }

      const contextChunks = results.map((r) => ({
        fileName: r.payload.fileName,
        chunk: r.payload.chunk,
        filePath: r.payload.filePath,
        score: r.score ?? 0,
      }));

      const response = await chatWithDocuments(q, contextChunks);
      log.info({ answerLength: response.answer.length, expandMode }, 'RAG search complete');

      return {
        answer: response.answer,
        sources: response.sources,
        expandMode,
      };
    } catch (error) {
      log.error({ error }, 'RAG search error');
      return reply.status(500).send({ error: 'RAG search failed' });
    }
  });
}