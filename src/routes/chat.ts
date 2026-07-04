import type { FastifyInstance } from 'fastify';
import { embedText } from '../services/embed.js';
import { searchChunks, expandHits, type ExpandMode, type DocumentChunk } from '../services/qdrant.js';
import { chatWithDocuments } from '../services/openai-api-wrapper.js';
import { ConversationStore } from '../services/conversations.js';
import { chatLog as log } from '../utils/logger.js';
import type Database from 'better-sqlite3';

type DB = Database.Database;

// /api/chat — non-streaming chat endpoint (kept for back-compat and
// for scripts / automation that prefer a single JSON response over SSE).
// Persistence moved from Phase 01's in-memory Map to ConversationStore
// so the response survives container restarts.

const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_HISTORY_MAX_TURNS = parseInt(process.env.CHAT_HISTORY_MAX_TURNS || '20', 10);

function parseExpandMode(value: string | undefined): ExpandMode {
  if (value === 'sections' || value === 'siblings') return value;
  // Phase 03 / OD-1: the streaming endpoint (/api/chat/stream)
  // defaults to `auto`. The non-streaming /api/chat endpoint
  // doesn't run the agent loop (the SPA only streams); `auto` here
  // resolves to `none` so non-streaming callers opt out of any
  // expansion logic.
  return 'none';
}

function mapHitForResponse(hit: DocumentChunk) {
  return {
    fileName: hit.payload.fileName,
    text: hit.payload.chunk.slice(0, 200) + (hit.payload.chunk.length > 200 ? '...' : ''),
    filePath: hit.payload.filePath,
    score: hit.score ?? 0,
  };
}

function mapContextChunks(results: DocumentChunk[]) {
  return results.map((r) => ({
    fileName: r.payload.fileName,
    chunk: r.payload.chunk,
    filePath: r.payload.filePath,
    score: r.score ?? 0,
  }));
}

export async function chatRoutes(fastify: FastifyInstance) {
  const db = (fastify as unknown as { db: DB }).db;
  const store = new ConversationStore(db);

  // POST /api/chat — non-streaming chat (FR-1 path migration; back-compat
  // for scripts that want a single JSON response).
  fastify.post('/api/chat', async (request, reply) => {
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

    let sid = sessionId;
    if (sid === undefined) {
      const created = store.create();
      sid = created.id;
    }
    if (!SESSION_ID_REGEX.test(sid)) {
      log.warn({ sessionId }, 'Invalid sessionId rejected');
      return reply.status(400).send({ error: 'Invalid sessionId: must match [A-Za-z0-9_-]{1,64}' });
    }

    const limitNum = Math.min(parseInt(limit || '5') || 5, 20);
    const expandMode = parseExpandMode(expand);

    try {
      log.debug({ questionLength: q.length, sessionId: sid, expandMode }, 'Processing chat request');
      const queryVector = await embedText(q);
      // Phase 04 / p4-T11 / FR-38 — scope retrieval to the
      // requester. Without this, chat would leak foreign private
      // chunks into the prompt. request.user is populated by the
      // auth plugin (p4-T05); non-null by the time we get here.
      const viewerId = request.user!.id;
      const baseResults = await searchChunks(queryVector, { limit: limitNum }, viewerId);
      const results = await expandHits(baseResults, { mode: expandMode }, viewerId);

      if (results.length === 0) {
        log.info({ sessionId: sid }, 'No relevant documents found');
        // Persist the user message even when there's no context — keeps
        // the conversation history honest.
        store.appendUserMessage(sid, q);
        return {
          answer: 'No relevant documents found. Try indexing some documents first.',
          sources: [],
          sessionId: sid,
          expandMode,
          title: store.get(sid)?.title ?? 'New chat',
        };
      }

      const contextChunks = mapContextChunks(results);

      const allMessages = store.listMessages(sid);
      const recent = allMessages.slice(-DEFAULT_HISTORY_MAX_TURNS * 2);
      const history = recent.map((m) => ({ role: m.role, content: m.content }));

      const response = await chatWithDocuments(q, contextChunks, history);
      const sources = response.sources.map((s) => ({
        fileName: s.fileName,
        text: s.text,
        filePath: s.filePath,
        score: s.score,
      }));

      // Persist this turn before returning.
      store.appendUserMessage(sid, q);
      store.appendAssistantMessage(sid, response.answer, results.map((r) => ({
        fileName: r.payload.fileName,
        filePath: r.payload.filePath,
        chunk: r.payload.chunk,
        pageNumber: r.payload.pageNumber,
        headingPath: r.payload.headingPath,
        score: r.score ?? 0,
      })));

      // First-exchange auto-title is handled by /api/chat/stream (p2-p1-T12)
      // which can deliver it via SSE event: title. For /api/chat the
      // sync path, the title field is whatever the conversation already
      // has (still 'New chat' until the async generator lands; the
      // client can poll GET /api/sessions/:id to refresh).
      const title = store.get(sid)?.title ?? 'New chat';

      log.info(
        { sessionId: sid, answerLength: response.answer.length, expandMode },
        'Chat response sent'
      );
      return {
        answer: response.answer,
        sources,
        sessionId: sid,
        expandMode,
        title,
      };
    } catch (error) {
      log.error({ error, sessionId: sid }, 'Chat error');
      return reply.status(500).send({ error: 'Chat failed' });
    }
  });

  // DELETE /api/chat/:sessionId — drop a session entirely. p2-T07's
  // /api/sessions/:id DELETE does the same thing with cascade; this
  // alias keeps the original Phase 01 contract intact.
  fastify.delete<{ Params: { sessionId: string } }>(
    '/api/chat/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;
      if (!SESSION_ID_REGEX.test(sessionId)) {
        return reply.status(400).send({ error: 'Invalid sessionId' });
      }
      const ok = store.delete(sessionId);
      log.info({ sessionId, deleted: ok }, 'Conversation cleared');
      if (!ok) return reply.status(404).send({ error: 'Session not found' });
      return { success: true, sessionId };
    }
  );
}