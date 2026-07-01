import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { log } from '../utils/logger.js';

type DB = Database.Database;

// SQLite singleton + connection setup.
//
// The default path comes from SQLITE_PATH (per FR-49 / design.md §Data
// model). In Docker this is /app/data/conversations.db; locally it's
// ./data/conversations.db. The directory is created lazily so a fresh
// volume doesn't need a separate mkdir step.
//
// PRAGMAs applied at every open (NFR-4):
// - journal_mode = WAL: concurrent readers while a writer holds the
//   DB. Required because the upload route writes messages while the
//   /api/upload/progress SSE handler reads from the same connection
//   pool.
// - foreign_keys = ON: enforce cascade deletes on messages when a
//   conversation is removed. SQLite defaults this to OFF, which would
//   silently keep orphaned messages.
//
// Tests should construct their own Database(':memory:') and pass it
// to services that need it (ConversationStore, etc.) — the singleton
// is for production runtime only.

let cached: DB | null = null;
let cachedPath: string | null = null;

export function getDbPath(): string {
  return process.env.SQLITE_PATH || path.resolve(process.cwd(), 'data', 'conversations.db');
}

export function openDb(): DB {
  const dbPath = getDbPath();
  if (cached && cachedPath === dbPath) return cached;
  if (cached && cachedPath !== dbPath) {
    cached.close();
    cached = null;
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info({ dir }, 'Created SQLite data directory');
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  log.info({ dbPath, journalMode: db.pragma('journal_mode', { simple: true }) }, 'SQLite opened');

  cached = db;
  cachedPath = dbPath;
  return db;
}

export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
    cachedPath = null;
  }
}

export function resetDbForTests(): void {
  if (cached) {
    cached.close();
  }
  cached = null;
  cachedPath = null;
}

export type { DB };
