import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ConversationStore } from '../services/conversations.js';
import { authPlugin } from '../services/auth.js';

// Routes under /api/sessions. Each route gets its own ConversationStore
// instance bound to the shared DB. Validates sessionId against the
// project-wide regex and rejects with 400 otherwise.
//
// FR-8..FR-13: session CRUD + message listing. Path migration cut lands
// in p2-T08; this file already uses the /api/* prefix.
//
// Phase 04 / p4-T14 / FR-42..44: every route here is viewer-scoped.
//
//   POST   stamps `owner_id = request.user.id` on the new row.
//   GET    returns only the caller's sessions (filter
//          `WHERE owner_id = request.user.id`).
//   GET /:id, GET /:id/messages, PATCH /:id, DELETE /:id
//          reject with 404 if the row's owner_id is not the caller.
//          404 (not 403) so the endpoint can't be used to enumerate
//          other users' session ids — same opaque-404 rule
//          api-documents.ts uses for files (FR-35). The auth plugin
//          runs first and returns 401 when no session cookie is
//          present, so all handlers here can rely on
//          request.user being set.
//
// FR-45: sessionId regex stays ^[A-Za-z0-9_-]{1,64}$ across the whole
// surface.

const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export const sessionRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  await fastify.register(authPlugin);
  const getStore = () => new ConversationStore((fastify as unknown as { db: import('better-sqlite3').Database }).db);
  const viewerId = (request: { user?: { id: string } }) => request.user!.id;

  // POST /api/sessions — create a new session.
  //
  // Returns the FULL Conversation (id, title, titleSource, createdAt,
  // updatedAt, messageCount), not a partial. The SPA's Conversation
  // type expects every field and SessionRow calls
  // relativeTime(updatedAt) — passing undefined would throw on the
  // next render and silently drop the activeId update that
  // handleCreate follows up with (so the new session appears in the
  // sidebar list but never becomes active).
  fastify.post('/api/sessions', async (request, reply) => {
    const session = getStore().create(viewerId(request));
    return reply.status(201).send(session);
  });

  // GET /api/sessions — list, most-recent first. Scoped to the caller.
  fastify.get('/api/sessions', async (request) => {
    return { sessions: getStore().list(viewerId(request)) };
  });

  // GET /api/sessions/:id — single session. 404 if not the caller's.
  fastify.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    if (!SESSION_ID_REGEX.test(id)) {
      return reply.status(400).send({ error: 'Invalid sessionId' });
    }
    const session = getStore().get(id);
    // FR-44 — opaque 404 (matches the document route). Foreign sessions
    // and missing sessions are indistinguishable from the wire.
    if (!session || session.ownerId !== viewerId(request)) {
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
      if (!session || session.ownerId !== viewerId(request)) {
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
      const store = getStore();
      // FR-44 — verify ownership before mutating. The store.rename()
      // mutation operates on row id alone, so the route layer is the
      // gatekeeper; same pattern as the DELETE route.
      const existing = store.get(id);
      if (!existing || existing.ownerId !== viewerId(request)) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      const session = store.rename(id, title);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      return session;
    }
  );

  // DELETE /api/sessions/:id — cascade delete. 404 if not the caller's.
  fastify.delete<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (request, reply) => {
      const { id } = request.params;
      if (!SESSION_ID_REGEX.test(id)) {
        return reply.status(400).send({ error: 'Invalid sessionId' });
      }
      const store = getStore();
      const existing = store.get(id);
      if (!existing || existing.ownerId !== viewerId(request)) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      store.delete(id);
      return reply.status(204).send();
    }
  );
};
