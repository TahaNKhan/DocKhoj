import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { downloadLog as log } from '../utils/logger.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILES_DIR = path.join(__dirname, '..', '..', 'documents');

interface IParams {
  filename: string;
}

export async function downloadRoutes(fastify: FastifyInstance) {
  await fs.promises.mkdir(FILES_DIR, { recursive: true });

  fastify.get<{ Params: IParams }>('/download/:filename', async (request, reply) => {
    log.info('Received download request');
    const { filename } = request.params;
    const filePath = path.join(FILES_DIR, filename);

    if (!fs.existsSync(filePath)) {
        log.info({ filePath }, 'File not found');
        return reply.callNotFound();
    }

    log.info({ filePath }, 'File found, sending to requester');
    const fileStream = fs.createReadStream(filePath);
    const ext = path.extname(filename);
    const contentType = ext === '.md' ? 'text/markdown' : 'text/plain';
    reply.header('Content-Type', contentType);
    return reply.send(fileStream);
  });
}