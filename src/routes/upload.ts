import { FastifyInstance, FastifyRequest } from 'fastify';
import { pipeline } from 'stream/promises';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { parseFile } from '../services/parser.js';
import { embedText } from '../services/embed.js';
import { upsertChunks } from '../services/qdrant.js';
import { chunkText } from '../utils/chunk.js';
import { uploadLog as log } from '../utils/logger.js';

const UPLOAD_DIR = './documents';
const BATCH_SIZE = 10;

export async function uploadRoutes(fastify: FastifyInstance) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  fastify.post('/upload', async (request, reply) => {
    log.info('Received upload request');
    const data = await request.file();

    if (!data) {
      log.warn('No file in request');
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const fileId = uuidv4();
    const fileName = data.filename;
    const ext = path.extname(fileName).toLowerCase();
    log.info({ fileId, fileName, ext }, 'File received');

    const filePath = path.join(UPLOAD_DIR, `${fileId}${ext}`);
    log.info({ filePath }, 'Saving file');
    await pipeline(data.file, fsSync.createWriteStream(filePath));
    log.info({ fileName }, 'File saved');

    let parsed;
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

    const chunkSize = parseInt(process.env.CHUNK_SIZE || '500');
    const chunkOverlap = parseInt(process.env.CHUNK_OVERLAP || '50');
    log.debug({ chunkSize, chunkOverlap }, 'Chunking text');
    const chunks = chunkText(parsed.text, chunkSize, chunkOverlap);
    log.info({ chunkCount: chunks.length }, 'Chunks created');

    let totalIndexed = 0;

    for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
      const batchChunks = chunks.slice(batchStart, batchEnd);
      log.debug({ batchStart, batchEnd, total: chunks.length }, 'Processing batch');

      const qdrantChunks = [];
      for (let i = 0; i < batchChunks.length; i++) {
        const chunk = batchChunks[i];
        const globalIndex = batchStart + i;
        try {
          const embedding = await embedText(chunk.text);
          qdrantChunks.push({
            id: uuidv4(),
            vector: embedding,
            payload: {
              chunk: chunk.text,
              fileName: fileName,
              fileType: parsed.fileType,
              chunkIndex: globalIndex,
              totalChunks: chunks.length,
            },
          });
        } catch (error) {
          log.error({ error, globalIndex }, 'Failed to embed chunk');
        }
      }

      if (qdrantChunks.length > 0) {
        log.debug({ batchSize: qdrantChunks.length }, 'Upserting batch');
        await upsertChunks(qdrantChunks);
        totalIndexed += qdrantChunks.length;
      }
    }

    log.info({ totalIndexed, fileName }, 'Upload complete');
    return {
      success: true,
      fileName,
      chunksIndexed: totalIndexed,
      fileId,
    };
  });

  fastify.post('/upload/batch', async (request, reply) => {
    log.info('Received batch upload request');
    const files = [];

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const fileId = uuidv4();
        const fileName = part.filename;
        const ext = path.extname(fileName).toLowerCase();
        const filePath = path.join(UPLOAD_DIR, `${fileId}${ext}`);

        await pipeline(part.file, fsSync.createWriteStream(filePath));

        try {
          const parsed = await parseFile(filePath);
          const chunkSize = parseInt(process.env.CHUNK_SIZE || '500');
          const chunkOverlap = parseInt(process.env.CHUNK_OVERLAP || '50');
          const chunks = chunkText(parsed.text, chunkSize, chunkOverlap);

          let totalIndexed = 0;

          for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
            const batchChunks = chunks.slice(batchStart, batchEnd);

            const qdrantChunks = [];
            for (let i = 0; i < batchChunks.length; i++) {
              const chunk = batchChunks[i];
              const globalIndex = batchStart + i;
              const embedding = await embedText(chunk.text);
              qdrantChunks.push({
                id: uuidv4(),
                vector: embedding,
                payload: {
                  chunk: chunk.text,
                  fileName: fileName,
                  fileType: parsed.fileType,
                  chunkIndex: globalIndex,
                  totalChunks: chunks.length,
                },
              });
            }

            await upsertChunks(qdrantChunks);
            totalIndexed += qdrantChunks.length;
          }

          files.push({
            fileName,
            chunksIndexed: totalIndexed,
            fileId,
          });
        } catch (error) {
          log.error({ error, fileName }, 'Failed to process file');
        }
      }
    }

    log.info({ fileCount: files.length }, 'Batch upload complete');
    return {
      success: true,
      files,
    };
  });

  fastify.get('/files', async (request, reply) => {
    const qdrant = await import('../services/qdrant.js');
    const info = await qdrant.getCollectionInfo();
    return {
      totalChunks: info.points_count,
    };
  });
}