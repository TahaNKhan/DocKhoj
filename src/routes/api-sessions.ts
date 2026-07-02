import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ConversationStore } from '../services/conversations.js';

// Routes under /api/sessions. Each route gets its own ConversationStore
// instance bound to the shared DB. Validates sessionId against the
// project-wide regex and rejects with 400 otherwise.
//
// FR-8..FR-13: session CRUD + message listing. Path migration cut lands
// in p2-T08; this file already uses the /api/* prefix.

const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export const sessionRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const getStore = () => new ConversationStore((fastify as unknown as { db: import('better-sqlite3').Database }).db);

  // POST /api/sessions — create a new session.
  //
  // Returns the FULL Conversation (id, title, titleSource, createdAt,
  // updatedAt, messageCount), not a partial. The SPA's Conversation
  // type expects every field and SessionRow calls
  // relativeTime(updatedAt) — passing undefined would throw on the
  // next render and silently drop the activeId update that
  // handleCreate follows up with (so the new session appears in the
  // sidebar list but never becomes active).
  fastify.post('/api/sessions', async (_request, reply) => {
    const session = getStore().create();
    return reply.status(201).send(session);
  });

  // GET /api/sessions — list, most-recent first.
  fastify.get('/api/sessions', async () => {
    return { sessions: getStore().list() };
  });

  // GET /api/sessions/:id — single session.
  fastify.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    if (!SESSION_ID_REGEX.test(id)) {
      return reply.status(400).send({ error: 'Invalid sessionId' });
    }
    const session = getStore().get(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return session;
  });

  // GET /api/sessions/:id/messages — chronological turns.
  fastify.get<{ Params: { id: string } }>(
    '/api/sessions/:id/messages',
    async (request, reply) => {
      const { id } = request.params;
      if (!SESSION_ID_REGEX.test(id)) {
        return reply.status(400).send({ error: 'Invalid sessionId' });
      }
      const store = getStore();
      const session = store.get(id);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      return { messages: store.listMessages(id) };
    }
  );

  // PATCH /api/sessions/:id — rename.
  fastify.patch<{ Params: { id: string }; Body: { title?: string } }>(
    '/api/sessions/:id',
    async (request, reply) => {
      const { id } = request.params;
      const { title } = request.body || {};
      if (!SESSION_ID_REGEX.test(id)) {
        return reply.status(400).send({ error: 'Invalid sessionId' });
      }
      if (typeof title !== 'string' || title.trim().length === 0) {
        return reply.status(400).send({ error: 'title is required' });
      }
      const session = getStore().rename(id, title);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      return session;
    }
  );

  // DELETE /api/sessions/:id — cascade delete.
  fastify.delete<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (request, reply) => {
      const { id } = request.params;
      if (!SESSION_ID_REGEX.test(id)) {
        return reply.status(400).send({ error: 'Invalid sessionId' });
      }
      const ok = getStore().delete(id);
      if (!ok) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      return reply.status(204).send();
    }
  );
};
