import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { downloadLog as log } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_FILES_DIR = path.join(__dirname, '..', '..', 'documents');

interface IParams {
  filename: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.json': 'application/json',
};

function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function isPathSafe(resolved: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  return resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot;
}

export async function downloadRoutes(
  fastify: FastifyInstance,
  options?: { filesDir?: string }
) {
  const filesDir = options?.filesDir ?? DEFAULT_FILES_DIR;
  await fs.promises.mkdir(filesDir, { recursive: true });

  fastify.get<{ Params: IParams }>('/api/download/:filename', async (request, reply) => {
    const { filename } = request.params;
    log.debug({ filename }, 'Received download request');

    const safeName = path.basename(filename);
    const resolved = path.resolve(filesDir, safeName);

    if (!isPathSafe(resolved, filesDir) || safeName !== filename) {
      log.warn({ filename, resolved }, 'Path traversal attempt blocked');
      return reply.callNotFound();
    }

    if (!fs.existsSync(resolved)) {
      log.info({ filePath: resolved }, 'File not found');
      return reply.callNotFound();
    }

    log.info({ filePath: resolved }, 'File found, sending to requester');
    const fileStream = fs.createReadStream(resolved);
    reply.header('Content-Type', contentTypeFor(safeName));
    return reply.send(fileStream);
  });
}