import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { hashPassword } from './password.js';

type DB = Database.Database;

// UserStore — SQLite-backed persistence for the `users` table
// (migration 005_users.sql).
//
// Convention: matches the existing stores — DB rows are snake_case,
// the returned interface is camelCase. Timestamps are SQLite TEXT
// ('YYYY-MM-DD HH:MM:SS' UTC), returned as opaque strings.
//
// Username validation (FR-2) lives here because every write path
// (createUser, register route, admin route) needs the same check.
// The regex is intentionally ASCII — usernames are case-sensitive
// identifiers, not display names.

export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
}

interface UserDbRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
}

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export function validateUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

// Phase 06 / p6-T02 — sentinel for OIDC-provisioned users.
//
// why: `users.password_hash` is NOT NULL (Phase 04). SQLite cannot drop
// a NOT NULL constraint without a table rebuild, which is risky against
// a live users table. The sentinel — a magic string — sidesteps the
// rebuild: `verifyPassword(plain, '!oidc!')` returns false because the
// stored value isn't in the `scrypt$…` format, so the format check
// rejects it before any comparison. OIDC users structurally cannot
// password-login by construction. If a future phase wants real nullable
// hashes, the table rebuild happens then with a clean migration.
export const OIDC_PASSWORD_SENTINEL = '!oidc!';

export class UserStore {
  constructor(private readonly db: DB) {}

  /** Insert a new user. Hashes the password with `hashPassword` before
   *  storing. Throws on invalid username or duplicate username (the
   *  UNIQUE constraint surfaces as a better-sqlite3 error). */
  async createUser({ username, password, role }: CreateUserInput): Promise<User> {
    if (!validateUsername(username)) {
      throw new Error(`Invalid username: must match ${USERNAME_RE.source}`);
    }
    const passwordHash = await hashPassword(password);
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, username, passwordHash, role);
    const user = this.findById(id);
    if (!user) {
      throw new Error('createUser: row vanished after insert');
    }
    return user;
  }

  findByUsername(username: string): User | null {
    const row = this.db
      .prepare(
        `SELECT id, username, password_hash, role, created_at, last_login_at
         FROM users WHERE username = ?`,
      )
      .get(username) as UserDbRow | undefined;
    return row ? toUser(row) : null;
  }

  findById(id: string): User | null {
    const row = this.db
      .prepare(
        `SELECT id, username, password_hash, role, created_at, last_login_at
         FROM users WHERE id = ?`,
      )
      .get(id) as UserDbRow | undefined;
    return row ? toUser(row) : null;
  }

  updateLastLogin(id: string): void {
    this.db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(id);
  }

  listAll(): User[] {
    const rows = this.db
      .prepare(
        `SELECT id, username, password_hash, role, created_at, last_login_at
         FROM users ORDER BY created_at ASC, id ASC`,
      )
      .all() as UserDbRow[];
    return rows.map(toUser);
  }

  /** Returns true if a row was deleted, false if no row matched. */
  deleteById(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  updatePasswordHash(id: string, hash: string): void {
    this.db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, id);
  }

  /** Phase 04 / p4-T07 / FR-17 — atomic hash swap + session revoke.
   *  Wraps the UPDATE and the caller's `revokeSessions(userId)` in
   *  a single SQLite transaction so a partial failure can't leave
   *  the user with a fresh hash while old sessions linger (or
   *  vice-versa). Returns the number of sessions the caller
   *  revoked. The `revokeSessions` callback keeps the UserStore
   *  unaware of the AuthSessionStore — same one-direction-of-deps
   *  principle the rest of the stores follow. */
  resetPasswordAndRevokeSessions(
    id: string,
    hash: string,
    revokeSessions: (userId: string) => number,
  ): number {
    return this.db.transaction(() => {
      this.updatePasswordHash(id, hash);
      return revokeSessions(id);
    })();
  }

  usernameExists(username: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM users WHERE username = ?`)
      .get(username);
    return row !== undefined;
  }

  // Phase 06 / p6-T02 — insert an OIDC-provisioned user. Skips
  // hashPassword (the whole point: OIDC users have no password); the
  // OIDC_PASSWORD_SENTINEL takes its place. The `user_identities` row
  // added in T01 is the authoritative link; the sentinel just means
  // "no password."
  async createOidcUser({ username, role }: { username: string; role: UserRole }): Promise<User> {
    if (!validateUsername(username)) {
      throw new Error(`Invalid username: must match ${USERNAME_RE.source}`);
    }
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, username, OIDC_PASSWORD_SENTINEL, role);
    const user = this.findById(id);
    if (!user) {
      throw new Error('createOidcUser: row vanished after insert');
    }
    return user;
  }

  /** Phase 06 / p6-T02 — recompute-on-login helper. Caller (T06) wants
   *  "ensure role is X"; this writes only when the role actually differs
   *  so we don't churn last-modified metadata on every OIDC callback. */
  updateRoleIfChanged(id: string, role: UserRole): boolean {
    const row = this.db
      .prepare(`SELECT role FROM users WHERE id = ?`)
      .get(id) as { role: string } | undefined;
    if (!row) return false;
    if (row.role === role) return false;
    this.db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id);
    return true;
  }
}

function toUser(r: UserDbRow): User {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    role: r.role as UserRole,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}