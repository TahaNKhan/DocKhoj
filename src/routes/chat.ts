import { FastifyInstance } from 'fastify';
import { embedText } from '../services/embed.js';
import { searchChunks, expandHits, type ExpandMode } from '../services/qdrant.js';
import { chatWithDocuments } from '../services/openai-api-wrapper.js';
import { chatLog as log } from '../utils/logger.js';

const conversations = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();

const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_HISTORY_MAX_TURNS = parseInt(process.env.CHAT_HISTORY_MAX_TURNS || '20', 10);

function pushBounded(
  history: { role: 'user' | 'assistant'; content: string }[],
  message: { role: 'user' | 'assistant'; content: string },
  maxTurns: number
): void {
  history.push(message);
  const maxMessages = maxTurns * 2;
  while (history.length > maxMessages) {
    history.shift();
  }
}

export async function chatRoutes(fastify: FastifyInstance) {
  fastify.post('/chat', async (request, reply) => {
    const body = request.body as {
      q?: string;
      sessionId?: string;
      limit?: string;
      expand?: string;
    };
    const { q, sessionId, limit, expand } = body;

    if (!q) {
      return reply.status(400).send({ error: 'Question "q" is required' });
    }

    let sid = sessionId ?? 'default';
    if (!SESSION_ID_REGEX.test(sid)) {
      log.warn({ sessionId }, 'Invalid sessionId rejected');
      return reply.status(400).send({ error: 'Invalid sessionId: must match [A-Za-z0-9_-]{1,64}' });
    }
    if (sid === 'default' && sessionId === undefined) {
      sid = 'default';
    }

    if (!conversations.has(sid)) {
      conversations.set(sid, []);
    }
    const history = conversations.get(sid)!;

    const limitNum = Math.min(parseInt(limit || '5') || 5, 20);
    const expandMode: ExpandMode =
      expand === 'sections' || expand === 'siblings' ? expand : 'none';

    try {
      log.debug({ questionLength: q.length, sessionId: sid, expandMode }, 'Processing chat request');
      const queryVector = await embedText(q);
      const baseResults = await searchChunks(queryVector, { limit: limitNum });
      const results = await expandHits(baseResults, { mode: expandMode });

      if (results.length === 0) {
        log.info({ sessionId: sid }, 'No relevant documents found');
        return {
          answer: 'No relevant documents found. Try indexing some documents first.',
          sources: [],
          sessionId: sid,
          expandMode,
        };
      }

      const contextChunks = results.map((r) => ({
        fileName: r.payload.fileName,
        chunk: r.payload.chunk,
        filePath: r.payload.filePath,
        score: r.score ?? 0,
      }));

      const response = await chatWithDocuments(q, contextChunks, history);

      pushBounded(
        history,
        { role: 'user', content: q },
        DEFAULT_HISTORY_MAX_TURNS
      );
      pushBounded(
        history,
        { role: 'assistant', content: response.answer },
        DEFAULT_HISTORY_MAX_TURNS
      );

      log.info(
        { sessionId: sid, answerLength: response.answer.length, expandMode },
        'Chat response sent'
      );
      return {
        answer: response.answer,
        sources: response.sources,
        sessionId: sid,
        expandMode,
      };
    } catch (error) {
      log.error({ error, sessionId: sid }, 'Chat error');
      return reply.status(500).send({ error: 'Chat failed' });
    }
  });

  fastify.delete<{ Params: { sessionId: string } }>('/chat/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    if (!SESSION_ID_REGEX.test(sessionId)) {
      return reply.status(400).send({ error: 'Invalid sessionId' });
    }
    conversations.delete(sessionId);
    log.info({ sessionId }, 'Conversation cleared');
    return { success: true, sessionId };
  });
}