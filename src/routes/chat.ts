import { FastifyInstance } from 'fastify';
import { embedText } from '../services/embed.js';
import { searchChunks } from '../services/qdrant.js';
import { chatWithDocuments } from '../services/openai-api-wrapper.js';
import { chatLog as log } from '../utils/logger.js';

const conversations = new Map<
  string,
  { role: 'user' | 'assistant'; content: string }[]
>();

export async function chatRoutes(fastify: FastifyInstance) {
  fastify.post('/chat', async (request, reply) => {
    const { q, sessionId, limit } = request.body as {
      q?: string;
      sessionId?: string;
      limit?: string;
    };

    if (!q) {
      return reply.status(400).send({ error: 'Question "q" is required' });
    }

    const sid = sessionId || 'default';
    if (!conversations.has(sid)) {
      conversations.set(sid, []);
    }
    const history = conversations.get(sid)!;

    const limitNum = Math.min(parseInt(limit || '5'), 20);

    try {
      log.debug({ questionLength: q.length, sessionId: sid }, 'Processing chat request');
      const queryVector = await embedText(q);
      const results = await searchChunks(queryVector, { limit: limitNum });

      if (results.length === 0) {
        log.info({ sessionId: sid }, 'No relevant documents found');
        return {
          answer: 'No relevant documents found. Try indexing some documents first.',
          sources: [],
          sessionId: sid,
        };
      }

      const contextChunks = results.map((r) => ({
        fileName: r.payload.fileName,
        chunk: r.payload.chunk,
        filePath: r.payload.filePath,
        score: r.score ?? 0,
      }));

      const response = await chatWithDocuments(q, contextChunks, history);

      history.push({ role: 'user', content: q });
      history.push({ role: 'assistant', content: response.answer });

      log.info({ sessionId: sid, answerLength: response.answer.length }, 'Chat response sent');
      return {
        answer: response.answer,
        sources: response.sources,
        sessionId: sid,
      };
    } catch (error) {
      log.error({ error, sessionId: sid }, 'Chat error');
      return reply.status(500).send({ error: 'Chat failed' });
    }
  });

  fastify.delete('/chat/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId?: string };
    const sid = sessionId || 'default';
    conversations.delete(sid);
    log.info({ sessionId: sid }, 'Conversation cleared');
    return { success: true, sessionId: sid };
  });
}