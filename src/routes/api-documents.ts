import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import type Database from 'better-sqlite3';
import { DocumentStore } from '../services/document-store.js';
import { deleteByFilePath } from '../services/qdrant.js';
import { uploadLog as log } from '../utils/logger.js';

type DB = Database.Database;

// Phase 03 / p3-T02 — Documents API.
//
//   GET    /api/documents          → list (FR-3, U13)
//   DELETE /api/documents/:fileId  → delete (FR-4, FR-5, U14, U15)
//
// Delete order (FR-5):
//   1. Qdrant filter delete — failure aborts. Disk + SQLite untouched.
//   2. File unlink — best-effort. ENOENT is fine; logged at debug.
//      Other errors log warn but the row still goes (the user explicitly
//      asked to delete).
//   3. SQLite row delete. Idempotent — a re-DELETE returns 404.
//
// The fileId regex restricts to ^[A-Za-z0-9_-]{1,64}$ (matches the
// existing sessionId validator) so the on-disk path can't escape
// UPLOAD_DIR even if `row.file_name` is exotic.

const UPLOAD_DIR = process.env.UPLOAD_DIR || './documents';
const FILE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export const documentRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const db = (fastify as unknown as { db: DB }).db;
  const store = new DocumentStore(db);

  // GET /api/documents — list all uploaded documents, most-recent first.
  fastify.get('/api/documents', async () => {
    return { documents: store.list() };
  });

  // DELETE /api/documents/:fileId — remove a single document (FR-4).
  fastify.delete<{ Params: { fileId: string } }>(
    '/api/documents/:fileId',
    async (request, reply) => {
      const { fileId } = request.params;

      // Step 0: validate fileId shape. Same regex as the sessionId
      // validator — keeps the on-disk path join() safe regardless
      // of file_name contents.
      if (!FILE_ID_REGEX.test(fileId)) {
        return reply.status(400).send({ error: 'Invalid fileId' });
      }

      // Step 1: look up the row.
      const row = store.get(fileId);
      if (!row) {
        return reply.status(404).send({ error: 'Document not found' });
      }

      const ext = path.extname(row.fileName).toLowerCase();
      const onDiskName = `${fileId}${ext}`;
      const fullPath = path.join(UPLOAD_DIR, onDiskName);

      // Step 2: Qdrant filter delete — failure aborts.
      let chunksDeleted = 0;
      try {
        chunksDeleted = await deleteByFilePath(onDiskName);
      } catch (err) {
        log.error({ err, fileId }, 'Qdrant delete failed');
        return reply.status(500).send({ error: 'Failed to delete chunks' });
      }

      // Step 3: unlink the file (best-effort).
      try {
        await fs.unlink(fullPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          log.warn({ err, fullPath }, 'File unlink failed (non-fatal)');
        } else {
          log.debug({ fullPath }, 'File already gone');
        }
      }

      // Step 4: SQLite row delete.
      store.delete(fileId);

      log.info(
        { fileId, fileName: row.fileName, chunksDeleted },
        'Document deleted'
      );
      return { success: true, chunksDeleted, fileId };
    }
  );
};