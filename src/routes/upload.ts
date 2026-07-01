import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { pipeline } from 'stream/promises';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { parseFile } from '../services/parser.js';
import { embedText, embedTexts } from '../services/embed.js';
import { upsertChunks, type DocumentChunk } from '../services/qdrant.js';
import { chunkBlocks } from '../utils/chunk.js';
import { truncateForLog, uploadLog as log } from '../utils/logger.js';

const UPLOAD_DIR = './documents';
const BATCH_SIZE = 10;

// uploadBus — progress events for in-flight uploads. Subscribed by the
// /api/upload/progress SSE handler (T35) and consumed by the SPA queue
// rows (T36). The handler in T35 registers listeners; this file
// publishes per-stage progress so the SSE handler can fan-out to any
// number of connected clients.
//
// Event shape:
//   { fileName, status: 'queued'|'embedding'|'ready'|'failed',
//     progress: 0..100, chunksIndexed?: number, error?: string }
export const uploadBus = new EventEmitter();

interface ProcessUploadResult {
  status: 'success' | 'failed';
  fileName: string;
  fileId: string;
  chunksIndexed?: number;
  error?: string;
}

interface ProgressEvent {
  fileName: string;
  status: 'queued' | 'embedding' | 'ready' | 'failed';
  progress: number;
  chunksIndexed?: number;
  error?: string;
}

function emit(event: ProgressEvent): void {
  uploadBus.emit('file', event);
}

async function processUpload(
  filePath: string,
  fileName: string,
  fileId: string,
  parsed: Awaited<ReturnType<typeof parseFile>>
): Promise<ProcessUploadResult> {
  const chunkMaxTokens = parseInt(process.env.CHUNK_MAX_TOKENS || '512');
  const chunkOverlap = parseInt(process.env.CHUNK_OVERLAP_TOKENS || '64');
  const logPreview = parseInt(process.env.LOG_CHUNK_PREVIEW_CHARS || '200');

  emit({ fileName, status: 'embedding', progress: 0 });

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
        const pct = Math.floor((totalIndexed / chunks.length) * 100);
        emit({ fileName, status: 'embedding', progress: pct, chunksIndexed: totalIndexed });
      } catch (err) {
        log.error({ err, batchStart }, 'Failed to process batch');
      }
    }

    emit({ fileName, status: 'ready', progress: 100, chunksIndexed: totalIndexed });
    return {
      status: 'success',
      fileName,
      fileId,
      chunksIndexed: totalIndexed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Embedding failed';
    log.error({ err, fileName }, 'Upload processing failed');
    emit({ fileName, status: 'failed', progress: 0, error: message });
    return {
      status: 'failed',
      fileName,
      fileId,
      error: message,
    };
  }
}

async function saveUploadedFile(
  data: { filename: string; file: NodeJS.ReadableStream; toBuffer?: () => Promise<Buffer> }
): Promise<{ filePath: string; fileId: string; fileName: string; ext: string }> {
  const fileName = data.filename;
  const ext = path.extname(fileName).toLowerCase();
  const fileId = uuidv4();
  const internalFileName = `${fileId}${ext}`;
  const filePath = path.join(UPLOAD_DIR, internalFileName);

  if (data.toBuffer) {
    const buf = await data.toBuffer();
    await fs.writeFile(filePath, buf);
  } else {
    await pipeline(data.file, fsSync.createWriteStream(filePath));
  }

  return { filePath, fileId, fileName, ext };
}

export async function uploadRoutes(fastify: FastifyInstance) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  // POST /api/upload — single file (FR-25).
  fastify.post('/api/upload', async (request, reply) => {
    log.info('Received upload request');
    const data = await request.file();

    if (!data) {
      log.warn('No file in request');
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    emit({ fileName: data.filename, status: 'queued', progress: 0 });

    let saved: { filePath: string; fileId: string; fileName: string; ext: string };
    try {
      saved = await saveUploadedFile({
        filename: data.filename,
        file: data.file,
        toBuffer: data.toBuffer,
      });
    } catch (err) {
      log.error({ err }, 'Failed to save uploaded file');
      emit({ fileName: data.filename, status: 'failed', progress: 0, error: 'Failed to save uploaded file' });
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
      emit({ fileName, status: 'failed', progress: 0, error: message });
      return reply.status(400).send({ error: message });
    }

    const result = await processUpload(filePath, fileName, fileId, parsed);

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
    };
  });

  // POST /api/upload/batch — multi-file. Same uploadBus publishes.
  fastify.post('/api/upload/batch', async (request, reply) => {
    log.info('Received batch upload request');
    const files: ProcessUploadResult[] = [];

    const parts: Array<{
      type: string;
      filename?: string;
      file?: NodeJS.ReadableStream;
      toBuffer?: () => Promise<Buffer>;
    }> = [];

    for await (const part of request.parts()) {
      parts.push(part);
    }

    const fileParts = parts.filter((p) => p.type === 'file');

    for (const part of fileParts) {
      if (part.filename) emit({ fileName: part.filename, status: 'queued', progress: 0 });
    }

    const concurrency = parseInt(process.env.EMBEDDING_CONCURRENCY || '4');
    const queue = [...fileParts];

    const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
      while (queue.length > 0) {
        const part = queue.shift();
        if (!part) break;
        if (!part.filename || !part.file) continue;

        let saved: { filePath: string; fileId: string; fileName: string; ext: string };
        try {
          saved = await saveUploadedFile({
            filename: part.filename,
            file: part.file,
            toBuffer: part.toBuffer,
          });
        } catch (err) {
          log.error({ err, fileName: part.filename }, 'Failed to save uploaded file');
          files.push({
            status: 'failed',
            fileName: part.filename,
            fileId: '',
            error: 'Failed to save uploaded file',
          });
          emit({ fileName: part.filename ?? 'unknown', status: 'failed', progress: 0, error: 'Failed to save uploaded file' });
          continue;
        }

        try {
          const parsed = await parseFile(saved.filePath);
          const result = await processUpload(saved.filePath, saved.fileName, saved.fileId, parsed);
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
          emit({ fileName: saved.fileName, status: 'failed', progress: 0, error: 'Failed to process file' });
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
    return fsSync.readdirSync(UPLOAD_DIR).map((s) => ({ filePath: s }));
  });

  log.info('Upload routes registered');
}

void embedText;