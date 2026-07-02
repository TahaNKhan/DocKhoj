import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  openDb,
  closeDb,
  resetDbForTests,
  getDbPath,
} from '../../src/db/index.js';

// p2-p1-T20 — coverage for the db singleton. The integration loop boots the
// app which exercises openDb end-to-end, but vitest can't hit the
// singleton without going through the actual server. So we cover the
// singleton's lazy-create, caching, env-var, and reset paths here.

describe('openDb (singleton)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockhoj-db-'));
    process.env.SQLITE_PATH = path.join(tmpDir, 'conversations.db');
    resetDbForTests();
  });

  afterEach(() => {
    closeDb();
    delete process.env.SQLITE_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getDbPath honors the SQLITE_PATH env var', () => {
    expect(getDbPath()).toBe(path.join(tmpDir, 'conversations.db'));
  });

  it('falls back to ./data/conversations.db when SQLITE_PATH is unset', () => {
    delete process.env.SQLITE_PATH;
    const expected = path.resolve(process.cwd(), 'data', 'conversations.db');
    expect(getDbPath()).toBe(expected);
  });

  it('creates the data directory lazily if missing', () => {
    const nested = path.join(tmpDir, 'nested', 'subdir', 'conversations.db');
    process.env.SQLITE_PATH = nested;
    resetDbForTests();
    expect(fs.existsSync(nested)).toBe(false);

    openDb();
    expect(fs.existsSync(path.dirname(nested))).toBe(true);
    // SQLite created the file
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('returns the same cached connection on repeated calls', () => {
    const a = openDb();
    const b = openDb();
    expect(a).toBe(b);
  });

  it('swaps the cached connection when SQLITE_PATH changes', () => {
    const a = openDb();

    const otherPath = path.join(tmpDir, 'other.db');
    process.env.SQLITE_PATH = otherPath;
    const b = openDb();
    expect(b).not.toBe(a);
    // And the new file is opened
    expect(fs.existsSync(otherPath)).toBe(true);
  });

  it('closeDb releases the connection and resetDbForTests clears cache', () => {
    const a = openDb();
    expect(a).toBeTruthy();
    closeDb();
    // After close, openDb should produce a fresh handle
    const b = openDb();
    expect(b).not.toBe(a);
  });

  it('applies WAL journal mode and foreign_keys = ON pragmas', () => {
    const db = openDb();
    // Query the live pragmas to confirm they took effect on this connection
    const journal = db.pragma('journal_mode', { simple: true });
    expect(journal).toBe('wal');
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });
});