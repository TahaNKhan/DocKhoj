import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

type DB = Database.Database;

// InviteStore — SQLite-backed persistence for the `invites` table
// (migration 005_users.sql).
//
// Security model: only the SHA-256 of the raw token is stored. The
// raw token is shown to the admin exactly once at creation time and
// never recoverable. Verification hashes the incoming raw token with
// the same algorithm and looks up by `token_hash`.
//
// `create()` returns `{ id, token, expiresAt }` — the caller (the
// admin route) hands `token` to the admin's UI one time. After that,
// only the hash and metadata survive in the DB.

export interface Invite {
  id: string;
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedBy: string | null;
  usedAt: string | null;
}

export interface CreateInviteInput {
  createdBy: string;
  expiresInDays?: number;
}

export interface CreateInviteResult {
  id: string;
  token: string;
  expiresAt: string;
}

interface InviteDbRow {
  id: string;
  token_hash: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
}

export const DEFAULT_INVITE_TTL_DAYS = 7;

export class InviteStore {
  constructor(private readonly db: DB) {}

  create({ createdBy, expiresInDays = DEFAULT_INVITE_TTL_DAYS }: CreateInviteInput): CreateInviteResult {
    const id = uuidv4();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    this.db
      .prepare(
        `INSERT INTO invites (id, token_hash, created_by, expires_at)
         VALUES (?, ?, ?, datetime('now', '+' || ? || ' days'))`,
      )
      .run(id, tokenHash, createdBy, expiresInDays);
    const row = this.db
      .prepare(`SELECT expires_at FROM invites WHERE id = ?`)
      .get(id) as { expires_at: string };
    return { id, token, expiresAt: row.expires_at };
  }

  /** Look up an invite by the raw token string (e.g. one the user
   *  pasted from the invite link). Hashes the input and looks up by
   *  `token_hash`. Does NOT filter on expiry or `used_by` — that's
   *  the route handler's job (410 vs 404 distinction). */
  findByRawToken(rawToken: string): Invite | null {
    const tokenHash = hashToken(rawToken);
    const row = this.db
      .prepare(
        `SELECT id, token_hash, created_by, created_at, expires_at, used_by, used_at
         FROM invites WHERE token_hash = ?`,
      )
      .get(tokenHash) as InviteDbRow | undefined;
    return row ? toInvite(row) : null;
  }

  /** Mark an invite consumed by a specific user. Returns true on the
   *  first successful consume; false if already used (idempotent /
   *  single-use guard). */
  markUsed(id: string, userId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE invites
         SET used_by = ?, used_at = datetime('now')
         WHERE id = ? AND used_by IS NULL`,
      )
      .run(userId, id);
    return result.changes > 0;
  }

  /** All invites that have not been consumed and have not yet expired.
   *  Used by the admin invite list. */
  listOutstanding(): Invite[] {
    const rows = this.db
      .prepare(
        `SELECT id, token_hash, created_by, created_at, expires_at, used_by, used_at
         FROM invites
         WHERE used_by IS NULL AND expires_at > datetime('now')
         ORDER BY created_at DESC, id DESC`,
      )
      .all() as InviteDbRow[];
    return rows.map(toInvite);
  }

  deleteById(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM invites WHERE id = ?`).run(id);
    return result.changes > 0;
  }
}

export function hashToken(rawToken: string): string {
  // Hash the base64url string as bytes (UTF-8). No decode step — keeps
  // the encoding deterministic and avoids any base64url-vs-base64
  // ambiguity around '-' / '_' vs '+' / '/'.
  return createHash('sha256').update(rawToken).digest('base64');
}

function toInvite(r: InviteDbRow): Invite {
  return {
    id: r.id,
    tokenHash: r.token_hash,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedBy: r.used_by,
    usedAt: r.used_at,
  };
}