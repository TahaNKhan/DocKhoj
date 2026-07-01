import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { log } from '../utils/logger.js';

type DB = Database.Database;

// Hand-rolled migration runner (no lib; ~50 LOC).
//
// Files in `migrations/` are named `NNN_*.sql` where NNN is a numeric
// version. On startup, we read the set of applied versions from
// `_migrations`, then apply any unapplied files in ascending order
// inside a single transaction. The runner is idempotent: re-running
// after a successful apply is a no-op.
//
// Migration files are written to use `CREATE TABLE IF NOT EXISTS` so a
// partial apply (e.g. process killed mid-migration) self-heals on the
// next boot. Destructive migrations should still avoid that path —
// `ALTER TABLE` etc. won't be idempotent.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the migrations directory relative to this module. Works in
 * both the source tree (src/db/migrate.ts) and the compiled output
 * (dist/db/migrate.js) as long as the build copies the migrations
 * folder to dist/db/migrations.
 */
function resolveMigrationsDir(): string {
  return path.resolve(__dirname, 'migrations');
}

function listMigrationFiles(dir: string): { id: number; file: string; path: string }[] {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  return entries.map((file) => {
    const id = parseInt(file.split('_')[0] ?? '', 10);
    return { id, file, path: path.join(dir, file) };
  });
}

export interface MigrateResult {
  applied: number[];
  total: number;
}

export function migrate(db: DB, dir?: string): MigrateResult {
  const migrationsDir = dir ?? resolveMigrationsDir();
  const files = listMigrationFiles(migrationsDir);

  // Ensure the _migrations table exists. We re-apply this on every
  // boot — it's idempotent and cheap.
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set<number>(
    (db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id)
  );

  const toApply = files.filter((f) => !applied.has(f.id));
  if (toApply.length === 0) {
    log.info({ migrationsDir, total: files.length, applied: 0 }, 'No pending migrations');
    return { applied: [], total: files.length };
  }

  const appliedIds: number[] = [];
  // Wrap the whole batch in a single transaction. If any migration
  // fails, none of them persist — but since the SQL uses IF NOT EXISTS,
  // re-running the runner self-heals.
  db.transaction(() => {
    for (const m of toApply) {
      const sql = readFileSync(m.path, 'utf8');
      log.info({ id: m.id, file: m.file }, 'Applying migration');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(m.id);
      appliedIds.push(m.id);
    }
  })();

  log.info({ applied: appliedIds, total: files.length }, 'Migrations applied');
  return { applied: appliedIds, total: files.length };
}
