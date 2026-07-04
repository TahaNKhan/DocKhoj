import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';
import { isOllamaAvailable } from '../services/embed.js';
import {
  buildVisibilityFilter,
  qdrantClient,
  QDRANT_COLLECTION,
} from '../services/qdrant.js';
import { getLlmContextSize } from '../services/openai-api-wrapper.js';
import { DocumentStore } from '../services/document-store.js';

type DB = Database.Database;

// GET /api/status — surface the live system state for the TopBar
// chrome:
//   - chunks:           Qdrant collection chunk count SCOPED to
//                       buildVisibilityFilter(request.user.id) (p4-T15)
//   - documents:        count of documents in the `documents` SQLite
//                       table visible to the viewer (p4-T15) — own +
//                       shared, foreign private excluded.
//   - ollamaAvailable:  live Ollama reachability flag
//   - llmModel:         process-wide LLM_MODEL
//   - llmContextSize:   probed from the chat API at boot (or null if
//                       the provider doesn't expose one and the model
//                       isn't in our known-size table)
//
// Phase 04 / p4-T15: requires auth (handled by the global auth
// middleware in services/auth.ts — non-authenticated requests never
// reach this handler). The TopBar status indicator now reflects
// the per-user view of the corpus: two users on the same instance
// see different `chunks` and `documents` counts unless they happen
// to share the same corpus.
//
// The context-size probe is fired-and-forgotten on the first call;
// subsequent calls hit the cached value.

export const statusRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/api/status', async (request) => {
    // The global auth middleware populates request.user. Public
    // exemptions don't apply here — the auth plugin only bypasses
    // /api/auth/* and /api/health. We can safely assert.
    const viewerId = (request.user as { id: string } | undefined)?.id ?? '';

    const ollamaAvailable = await isOllamaAvailable();
    let chunks = 0;
    try {
      // p4-T15 / FR-15 — count only the chunks the viewer can see
      // (public + own private). Shared rows (ownerId NO_OWNER_SENTINEL
      // = '') collapse into the `visibility = public` arm of the
      // should-group, so legacy Phase 03 chunks still surface.
      const visClause = buildVisibilityFilter(viewerId);
      const result = (await qdrantClient.count(QDRANT_COLLECTION, {
        filter: visClause,
      } as unknown as Parameters<typeof qdrantClient.count>[1])) as {
        count?: number;
      };
      chunks = result.count ?? 0;
    } catch {
      // Qdrant unreachable — leave chunks at 0.
    }
    const llmContextSize = await getLlmContextSize();
    const db = (fastify as unknown as { db: DB }).db;
    // p4-T15 / FR-15 — documents count is also viewer-scoped.
    const documents = new DocumentStore(db).count(viewerId);
    return {
      chunks,
      documents,
      ollamaAvailable,
      llmModel: process.env.LLM_MODEL || 'gpt-4o',
      llmContextSize,
    };
  });
};
