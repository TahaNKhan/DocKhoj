import { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { parseFile } from '../services/parser.js';
import { embedText, embedTexts } from '../services/embed.js';
import {
  upsertChunks,
  setOwnerVisibility,
  type DocumentChunk,
  type Visibility,
} from '../services/qdrant.js';
import { DocumentStore } from '../services/document-store.js';
import { chunkBlocks } from '../utils/chunk.js';
import { truncateForLog, uploadLog as log } from '../utils/logger.js';

type DB = Database.Database;

// UPLOAD_DIR resolution order:
//   1. process.env.UPLOAD_DIR — honored in api-documents.ts and the
//      e2e test; upload.ts now respects it too so a single env var
//      controls the documents root everywhere.
//   2. $DOCKHOJ_HOME/documents — the in-Docker default. Compose
//      bind-mounts this path to /app/documents, then sets
//      UPLOAD_DIR=/app/documents in the container's env, which
//      wins at rung 1. Outside Docker (npm run dev), DOCKHOJ_HOME
//      is normally set by restart.sh; if it's unset we fall back
//      to ~/.dockhoj/documents so the default is the same in
//      both modes.
//   3. ~/.dockhoj/documents — the absolute-home fallback.
//
// ponytail: in-Docker path resolves to /app/documents only when
// the compose env is set; the host-side path is irrelevant
// inside the container because of the bind mount.
function resolveUploadDir(): string {
  if (process.env.UPLOAD_DIR) {
    return path.resolve(process.env.UPLOAD_DIR);
  }
  const dockhojHome = process.env.DOCKHOJ_HOME
    || path.join(os.homedir(), '.dockhoj');
  return path.join(dockhojHome, 'documents');
}

// Resolved on every call (not captured at module-load) so tests
// that set process.env.UPLOAD_DIR after import see the override.
const BATCH_SIZE = 10;

// Phase 04 / p4-T09 / FR-27 — visibility whitelist. Anything outside
// this set (including the missing-field default) is normalized below.
const VALID_VISIBILITY: readonly Visibility[] = ['public', 'private'];
const DEFAULT_VISIBILITY: Visibility = 'private';

// Upload progress strategy (replaces the earlier p2-p1-T14 SSE approach):
//   - Transport progress (file bytes flowing from the browser to the
//     server) is reported by the BROWSER via XMLHttpRequest's native
//     `upload.onprogress` event. No server-side work needed.
//   - Server-side parse + embed + index progress is hidden behind a
//     single POST /api/upload call; the route blocks until done and
//     returns { success, chunksIndexed, error? } in the response.
//     The browser waits for the response to know the final state.
//   - The SPA queue row therefore has three observable states:
//     uploading  (XHR.onprogress firing)  → 0..100% transport
//     indexing    (POST in-flight)        → indeterminate
//     done / failed (POST response)      → 100% or error
// This is the simplest mechanism that matches the observed UX: the
// browser knows when the bytes are flowing; the server reports when
// indexing is complete. No EventEmitter, no SSE channel, no
// per-process state machine to keep coherent across connections.

interface ProcessUploadResult {
  status: 'success' | 'failed';
  fileName: string;
  fileId: string;
  chunksIndexed?: number;
  error?: string;
}

async function processUpload(
  filePath: string,
  fileName: string,
  fileId: string,
  parsed: Awaited<ReturnType<typeof parseFile>>,
  db: DB,
  // Phase 04 / p4-T09 / FR-27/29/30 — owner + visibility threaded
  // through so the SQLite row and Qdrant chunks get stamped.
  ownerId: string | null,
  visibility: Visibility
): Promise<ProcessUploadResult> {
  const chunkMaxTokens = parseInt(process.env.CHUNK_MAX_TOKENS || '512');
  const chunkOverlap = parseInt(process.env.CHUNK_OVERLAP_TOKENS || '64');
  const logPreview = parseInt(process.env.LOG_CHUNK_PREVIEW_CHARS || '200');

  try {
    const chunks = await chunkBlocks(parsed.blocks, {
      maxTokens: chunkMaxTokens,
      overlapTokens: chunkOverlap,
    });
    log.info({ chunkCount: chunks.length, fileName }, 'Chunks created');

    let totalIndexed = 0;
    for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
      const batchChunks = chunks.slice(batchStart, batchEnd);

      try {
        const embeddings = await embedTexts(batchChunks.map((c) => c.text));
        const qdrantChunks: DocumentChunk[] = batchChunks.map((chunk, i) => {
          const embedding = embeddings[i];
          if (!embedding) throw new Error(`Missing embedding for chunk ${i}`);
          const payload = {
            chunk: chunk.text,
            fileName,
            filePath: path.basename(filePath),
            fileType: parsed.fileType,
            chunkIndex: chunk.index,
            totalChunks: chunks.length,
            blockKind: chunk.blockKind,
            headingPath: chunk.headingPath,
            pageNumber: chunk.pageNumber,
            tokenCount: chunk.tokenCount,
          };
          log.info(
            {
              ...payload,
              chunk: truncateForLog(payload.chunk, logPreview),
            },
            'Created chunk with payload'
          );
          return {
            id: uuidv4(),
            vector: embedding,
            payload,
          };
        });

        await upsertChunks(qdrantChunks);
        totalIndexed += qdrantChunks.length;
      } catch (err) {
        log.error({ err, batchStart }, 'Failed to process batch');
      }
    }

    // Phase 04 / p4-T09 / FR-29/30 — stamp ownerId + visibility on
    // every Qdrant chunk of this file. Runs AFTER all batches have
    // been upserted so the filter finds every chunk. Failure here
    // means the chunks are public-but-otherwise-present; the
    // existing row+disk cleanup below returns 500 and the SPA
    // retries. setOwnerVisibility's fileId arg is the on-disk
    // basename (`${fileId}${ext}`), which equals path.basename(filePath).
    try {
      await setOwnerVisibility(path.basename(filePath), ownerId, visibility);
    } catch (err) {
      log.error({ err, fileName, fileId }, 'Failed to stamp owner/visibility on chunks');
      return {
        status: 'failed',
        fileName,
        fileId,
        error: 'Failed to stamp owner/visibility',
      };
    }

    // Phase 03 / p3-T01: record the document in SQLite so the
    // Documents list can show it and DELETE /api/documents/:fileId
    // can find the row. Insert AFTER the Qdrant upsert succeeds so
    // a parse/embedding failure (return below) leaves no row.
    // If the SQLite insert itself fails, the chunks are still
    // indexed and the file is on disk — log and surface a
    // 500-equivalent failure so the SPA can retry. The
    // DocumentStore uses the same db singleton, so the
    // table existence is guaranteed by migration 003.
    try {
      const bytes = fsSync.statSync(filePath).size;
      new DocumentStore(db).insert({
        fileId,
        fileName,
        fileType: parsed.fileType.replace(/^\./, ''),
        bytes,
        uploadedAt: nowSqlite(),
        chunkCount: totalIndexed,
        ownerId,
        visibility,
      });
    } catch (err) {
      log.error({ err, fileName, fileId }, 'Failed to record document row');
      return {
        status: 'failed',
        fileName,
        fileId,
        error: 'Failed to record document',
      };
    }

    return {
      status: 'success',
      fileName,
      fileId,
      chunksIndexed: totalIndexed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Embedding failed';
    log.error({ err, fileName }, 'Upload processing failed');
    return {
      status: 'failed',
      fileName,
      fileId,
      error: message,
    };
  }
}

async function saveUploadedFile(
  data: { filename: string; content: Buffer }
): Promise<{ filePath: string; fileId: string; fileName: string; ext: string }> {
  const fileName = data.filename;
  const ext = path.extname(fileName).toLowerCase();
  const fileId = uuidv4();
  const internalFileName = `${fileId}${ext}`;
  const filePath = path.join(resolveUploadDir(), internalFileName);

  await fs.writeFile(filePath, data.content);

  return { filePath, fileId, fileName, ext };
}

export async function uploadRoutes(fastify: FastifyInstance) {
  await fs.mkdir(resolveUploadDir(), { recursive: true });
  const db = (fastify as unknown as { db: DB }).db;

  // POST /api/upload — single file (FR-25).
  fastify.post('/api/upload', async (request: FastifyRequest, reply) => {
    log.info('Received upload request');

    // Phase 04 / p4-T09 / FR-27 — parse the multipart parts up
    // front. We use parts() rather than file() so the visibility
    // field is available regardless of form-field ordering (the
    // busboy-based parser only finalizes the fields map AFTER the
    // file stream is consumed — see @fastify/multipart README).
    // The file stream must be consumed before the for-await loop
    // exits, otherwise the multipart parser hangs waiting for the
    // rest of the file bytes — so we buffer the first file part
    // eagerly and skip any further file parts.
    let fileBuf: Buffer | undefined;
    let fileNameFromPart: string | undefined;
    let visibilityRaw: string | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (fileBuf === undefined) {
          fileBuf = await part.toBuffer();
          fileNameFromPart = part.filename;
        }
      } else if (part.fieldname === 'visibility') {
        visibilityRaw = part.value as string;
      }
    }

    if (fileBuf === undefined || fileNameFromPart === undefined) {
      log.warn('No file in request');
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    // Phase 04 / p4-T09 / FR-27 — visibility defaults to 'private'
    // when the field is absent; anything else is a 400.
    const visibility: Visibility = (visibilityRaw ?? DEFAULT_VISIBILITY) as Visibility;
    if (!VALID_VISIBILITY.includes(visibility)) {
      return reply.status(400).send({
        error: `Invalid visibility: must be one of ${VALID_VISIBILITY.join(', ')}`,
      });
    }

    // authPlugin (registered before this plugin) guarantees
    // request.user on /api/upload. The non-null assertion is a
    // type-level contract — the 401 path lives in the middleware.
    const user = request.user!;

    let saved: { filePath: string; fileId: string; fileName: string; ext: string };
    try {
      saved = await saveUploadedFile({
        filename: fileNameFromPart,
        content: fileBuf,
      });
    } catch (err) {
      log.error({ err }, 'Failed to save uploaded file');
      return reply.status(500).send({ error: 'Failed to save uploaded file' });
    }

    const { filePath, fileId, fileName } = saved;
    log.info({ filePath, fileName, fileId }, 'File saved');

    let parsed: Awaited<ReturnType<typeof parseFile>>;
    try {
      log.debug({ fileName }, 'Parsing file');
      parsed = await parseFile(filePath);
      log.debug({ textLength: parsed.text.length, fileType: parsed.fileType }, 'File parsed');
    } catch (error) {
      log.error({ error, fileName }, 'Parse error');
      await fs.unlink(filePath).catch(() => {});
      const message = error instanceof Error ? error.message : 'Failed to parse file';
      return reply.status(400).send({ error: message });
    }

    const result = await processUpload(filePath, fileName, fileId, parsed, db, user.id, visibility);

    if (result.status === 'failed') {
      await fs.unlink(filePath).catch(() => {});
      return reply.status(500).send({
        success: false,
        fileName,
        fileId,
        error: result.error,
      });
    }

    log.info({ totalIndexed: result.chunksIndexed, fileName }, 'Upload complete');
    return {
      success: true,
      fileName,
      chunksIndexed: result.chunksIndexed,
      fileId,
      // Phase 04 / p4-T09 / FR-28 — response gains ownerUsername
      // and visibility so the SPA can render the chip without a
      // follow-up GET.
      ownerUsername: user.username,
      visibility,
    };
  });

  // POST /api/upload/batch — multi-file.
  fastify.post('/api/upload/batch', async (request, reply) => {
    log.info('Received batch upload request');
    // authPlugin guarantees request.user on /api/upload/batch.
    const user = request.user!;
    const files: ProcessUploadResult[] = [];

    // Same multipart-stream-consumption rule as /api/upload: drain
    // every file part's bytes INSIDE the for-await loop, or the
    // busboy parser hangs waiting for the rest of the body.
    type CollectedPart = { filename: string; content: Buffer };
    const collected: CollectedPart[] = [];

    for await (const part of request.parts()) {
      if (part.type === 'file' && part.filename) {
        const content = await part.toBuffer();
        collected.push({ filename: part.filename, content });
      }
    }

    const concurrency = parseInt(process.env.EMBEDDING_CONCURRENCY || '4');
    const queue = [...collected];

    const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
      while (queue.length > 0) {
        const part = queue.shift();
        if (!part) break;

        let saved: { filePath: string; fileId: string; fileName: string; ext: string };
        try {
          saved = await saveUploadedFile({
            filename: part.filename,
            content: part.content,
          });
        } catch (err) {
          log.error({ err, fileName: part.filename }, 'Failed to save uploaded file');
          files.push({
            status: 'failed',
            fileName: part.filename,
            fileId: '',
            error: 'Failed to save uploaded file',
          });
          continue;
        }

        try {
          const parsed = await parseFile(saved.filePath);
          // Phase 04 / p4-T09 — batch uploads don't take a
          // per-file visibility field; default to 'private' so each
          // file gets the owner stamp + visibility set.
          const result = await processUpload(
            saved.filePath,
            saved.fileName,
            saved.fileId,
            parsed,
            db,
            user.id,
            DEFAULT_VISIBILITY
          );
          if (result.status === 'failed') {
            await fs.unlink(saved.filePath).catch(() => {});
          }
          files.push(result);
        } catch (error) {
          log.error({ error, fileName: saved.fileName }, 'Failed to process file');
          await fs.unlink(saved.filePath).catch(() => {});
          files.push({
            status: 'failed',
            fileName: saved.fileName,
            fileId: saved.fileId,
            error: error instanceof Error ? error.message : 'Failed to process file',
          });
        }
      }
    });

    await Promise.all(workers);

    log.info({ fileCount: files.length }, 'Batch upload complete');
    return {
      success: true,
      files: files.map((f) => ({
        fileName: f.fileName,
        fileId: f.fileId,
        status: f.status,
        chunksIndexed: f.chunksIndexed,
        error: f.error,
      })),
    };
  });

  // GET /api/files — list uploaded internal filenames (used by
  // existing tests; not in the spec's HTTP table but kept under /api/
  // for convention).
  fastify.get('/api/files', async () => {
    return fsSync.readdirSync(resolveUploadDir()).map((s) => ({ filePath: s }));
  });

  log.info('Upload routes registered');
}

void embedText;

// SQLite datetime('now') shape: 'YYYY-MM-DD HH:MM:SS' UTC. Matches the
// convention used by services/conversations.ts (nowIso).
function nowSqlite(): string {
  return new Date()
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}