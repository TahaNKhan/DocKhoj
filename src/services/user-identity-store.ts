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

  /** Phase 07 / p7-T03 — list every identity row linked to a local user.
   *  Drives the /account/link/status read (password.set vs oidc.linked)
   *  and the "already linked" 409 in /account/link/sso/start. Design
   *  says at most one IdP per install, but returning the array keeps
   *  the contract honest if that assumption ever changes. */
  findByUserId(userId: string): Array<{ issuer: string; sub: string; createdAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT issuer, sub, created_at
         FROM user_identities
         WHERE user_id = ?
         ORDER BY created_at ASC`,
      )
      .all(userId) as Array<{ issuer: string; sub: string; created_at: string }>;
    return rows.map((r) => ({ issuer: r.issuer, sub: r.sub, createdAt: r.created_at }));
  }

  /** Phase 07 / p7-T03 — delete every identity row for a user. Used by
   *  /account/link/sso/unlink to unbind SSO. Caller wraps in a
   *  transaction so the delete + any side-effect (e.g. session revoke
   *  in a later task) lands atomically. Returns the number of rows
   *  actually deleted (0 is a no-op success). */
  unlinkAllForUser(userId: string): number {
    const result = this.db
      .prepare(`DELETE FROM user_identities WHERE user_id = ?`)
      .run(userId);
    return result.changes;
  }
}
