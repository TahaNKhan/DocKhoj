import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { migrate } from '../../src/db/migrate.js';

describe('migrate', () => {
  let db: ReturnType<typeof Database>;
  let migrationsDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrationsDir = path.resolve(
      __dirname,
      '..',
      '..',
      'src',
      'db',
      'migrations'
    );
    expect(fs.existsSync(migrationsDir)).toBe(true);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the _migrations table on a fresh DB', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .all();
    expect(tables).toHaveLength(0);

    migrate(db);

    const after = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .all();
    expect(after).toHaveLength(1);
  });

  it('applies all six migrations and records the version set', () => {
    const result = migrate(db);
    expect(result.applied).toContain(1);
    expect(result.applied).toContain(2);
    expect(result.applied).toContain(3);
    expect(result.applied).toContain(4);
    expect(result.applied).toContain(5);
    expect(result.applied).toContain(6);

    const rows = db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: number }[];
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);

    const conversations = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
      .all();
    expect(conversations).toHaveLength(1);

    const messages = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
      .all();
    expect(messages).toHaveLength(1);

    const documents = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")
      .all();
    expect(documents).toHaveLength(1);

    const users = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    expect(users).toHaveLength(1);

    const authSessions = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_sessions'")
      .all();
    expect(authSessions).toHaveLength(1);

    const invites = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invites'")
      .all();
    expect(invites).toHaveLength(1);

    const cols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('title_source');

    const docCols = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    expect(docCols.map((c) => c.name)).toContain('file_id');
    expect(docCols.map((c) => c.name)).toContain('chunk_count');
    expect(docCols.map((c) => c.name)).toContain('owner_id');
    expect(docCols.map((c) => c.name)).toContain('visibility');

    const msgCols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    expect(msgCols.map((c) => c.name)).toContain('tool_calls');

    // documents.visibility defaults to 'public' for legacy rows.
    db.exec("INSERT INTO documents (file_id, file_name, file_type, bytes) VALUES ('x', 'x', 'md', 1)");
    const vis = db.prepare("SELECT visibility FROM documents WHERE file_id = 'x'").get() as { visibility: string };
    expect(vis.visibility).toBe('public');
  });

  it('is idempotent — second boot is a no-op', () => {
    const first = migrate(db);
    expect(first.applied.length).toBeGreaterThan(0);

    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.total).toBe(first.total);
  });

  it('handles a missing migrations dir gracefully', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockhoj-empty-'));
    try {
      const result = migrate(db, emptyDir);
      expect(result.applied).toEqual([]);
      expect(result.total).toBe(0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});