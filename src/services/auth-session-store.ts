import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

type DB = Database.Database;

// AuthSessionStore — SQLite-backed persistence for the `auth_sessions`
// table (migration 005_users.sql).
//
// Session ids are 32 random bytes encoded as URL-safe base64 (43 chars
// before padding; Node's `base64url` strips it). The expiry is a
// rolling window: every `touch()` advances `expires_at` to
// `now + 30 days`, so an active session never expires until the user
// stops visiting for 30 days straight (per FR-4 / FR-8).
//
// `findById` filters by `expires_at > datetime('now')` — an expired
// session is indistinguishable from a non-existent one. Callers
// (auth middleware) treat both as 401.

export interface AuthSession {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface AuthSessionDbRow {
  id: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export const SESSION_TTL_DAYS = 30;

export class AuthSessionStore {
  constructor(private readonly db: DB) {}

  create(userId: string): AuthSession {
    const id = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, user_id, last_seen_at, expires_at)
         VALUES (?, ?, datetime('now'), datetime('now', '+${SESSION_TTL_DAYS} days'))`,
      )
      .run(id, userId);
    const session = this.findById(id);
    if (!session) {
      throw new Error('auth-session create: row vanished after insert');
    }
    return session;
  }

  /** Returns the session only if it has not expired. Otherwise null. */
  findById(id: string): AuthSession | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, created_at, last_seen_at, expires_at
         FROM auth_sessions
         WHERE id = ? AND expires_at > datetime('now')`,
      )
      .get(id) as AuthSessionDbRow | undefined;
    return row ? toAuthSession(row) : null;
  }

  /** Rolling-window refresh: bumps last_seen_at and pushes expires_at
   *  forward by SESSION_TTL_DAYS. Returns the refreshed session, or
   *  null if the session has been deleted in the meantime. */
  touch(id: string): AuthSession | null {
    this.db
      .prepare(
        `UPDATE auth_sessions
         SET last_seen_at = datetime('now'),
             expires_at = datetime('now', '+${SESSION_TTL_DAYS} days')
         WHERE id = ?`,
      )
      .run(id);
    return this.findById(id);
  }

  deleteById(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM auth_sessions WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Returns the number of rows deleted (used for "force logout all
   *  sessions" in the admin route, and for FK-cascade cleanup). */
  deleteByUser(userId: string): number {
    const result = this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
    return result.changes;
  }
}

function toAuthSession(r: AuthSessionDbRow): AuthSession {
  return {
    id: r.id,
    userId: r.user_id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
  };
}