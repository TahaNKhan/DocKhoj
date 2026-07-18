import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

type DB = Database.Database;

// UserIdentityStore — SQLite-backed persistence for the `user_identities`
// table (migration 008_oidc_identities.sql).
//
// One row per (issuer, sub) pair an OIDC provider handed us at callback
// time. The lookup path is always: SELECT user_id WHERE issuer=? AND sub=?
// (the unique index covers it). The local user this points at is always
// an OIDC-provisioned user (password_hash == '!oidc!' sentinel).
//
// Convention: matches the existing stores — DB rows are snake_case, the
// returned interface is camelCase. Timestamps are SQLite TEXT
// ('YYYY-MM-DD HH:MM:SS' UTC), set by DEFAULT datetime('now') on insert.

export class UserIdentityStore {
  constructor(private readonly db: DB) {}

  /** Resolves an OIDC (issuer, sub) to the local user_id, or null if
   *  this identity has never been linked. This is the callback-time
   *  hot path. */
  findUserIdByIssuerSub(issuer: string, sub: string): string | null {
    const row = this.db
      .prepare(`SELECT user_id FROM user_identities WHERE issuer = ? AND sub = ?`)
      .get(issuer, sub) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  /** Records that (issuer, sub) maps to the given local user. First
   *  write only — does not bump last_seen_at on conflict (UNIQUE on
   *  (issuer, sub) means a second link() for the same pair throws).
   *  T06 will add a touch() for last_seen_at refresh at callback time. */
  link(userId: string, issuer: string, sub: string): void {
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO user_identities (id, user_id, issuer, sub)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, userId, issuer, sub);
  }
}
