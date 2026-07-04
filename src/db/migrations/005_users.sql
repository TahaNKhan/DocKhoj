-- Phase 04 / p4-T02: user accounts + auth sessions + invites.
--
-- Three new tables. Naming follows the design.md schema:
--   - `users`           — credentials + role.
--   - `auth_sessions`   — server-side sessions tied to a cookie.
--                          Named `auth_sessions` to disambiguate from the
--                          existing `conversations` table (the chat-session
--                          table — physically named `conversations`, never
--                          `sessions`, despite older docs).
--   - `invites`         — single-use invite tokens. Only the SHA-256 hash of
--                          the raw token is stored; the raw token is shown
--                          to the admin once at creation time.
--
-- All FKs to `users` use ON DELETE CASCADE for sessions/invites (the user
-- is gone; their sessions/invites should not orphan).
-- `documents.owner_id` (added in 006_documents_owner.sql) uses ON DELETE
-- SET NULL because legacy public-marked files should survive user deletion.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ponytail: indexes trimmed to what the design actually queries.
--   - username + token_hash are UNIQUE → SQLite makes an implicit
--     index; explicit ones are duplicates.
--   - There's no auth_sessions expiry sweep in this phase, so an
--     expires_at index would be speculative.
--   - Keep `user_id` (used by deleteByUser + 'list my sessions') and
--     `invites.expires_at` (used by listOutstanding's expiry filter).
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
  ON auth_sessions (user_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_expires_at
  ON invites (expires_at);
