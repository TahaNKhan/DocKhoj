import { FastifyInstance } from 'fastify';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { DocumentStore } from '../services/document-store.js';
import { downloadLog as log } from '../utils/logger.js';

// Files-directory resolution — same ladder as upload.ts:
//   1. process.env.UPLOAD_DIR (the single env var that controls
//      the documents root everywhere; honored by upload.ts,
//      api-documents.ts, and the e2e suite).
//   2. $DOCKHOJ_HOME/documents — the in-Docker bind-mount target.
//   3. ~/.dockhoj/documents — the absolute-home fallback for
//      `npm run dev` without DOCKHOJ_HOME set.
//
// ponytail: identical shape to upload.ts. The two defaults used
// to drift (upload.ts → './documents' relative to cwd; download.ts
// → '<repo>/documents' absolute). They collapse into one
// resolution at the top of both files.
function resolveFilesDir(): string {
  if (process.env.UPLOAD_DIR) {
    return path.resolve(process.env.UPLOAD_DIR);
  }
  const dockhojHome = process.env.DOCKHOJ_HOME
    || path.join(os.homedir(), '.dockhoj');
  return path.join(dockhojHome, 'documents');
}

const DEFAULT_FILES_DIR = resolveFilesDir();

type DB = Database.Database;

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
  const db = (fastify as unknown as { db: DB }).db;
  const store = new DocumentStore(db);
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

    // Phase 04 / p4-T10 / FR-36 — authorize via the documents row.
    // The URL parameter is the on-disk basename = `${fileId}${ext}`,
    // matching the `filePath` field that SourceDrawer passes. Strip
    // the extension to recover the fileId, look up the row, and
    // return 404 unless the requester owns the file (or it's
    // shared). 404 (not 403) so the endpoint can't be used to
    // enumerate other users' files.
    const fileId = filename.replace(/\.[^.]+$/, '');
    const row = store.get(fileId);
    const viewerId = request.user!.id;
    if (!row || (row.ownerId !== null && row.ownerId !== viewerId)) {
      log.info({ filename, fileId }, 'Download denied (foreign or missing file)');
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