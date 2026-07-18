-- Phase 06 / p6-T01: OIDC identity linking.
-- One row per (issuer, sub) pair seen at login. The local users.id it
-- points at is always an OIDC-provisioned user (password_hash holds the
-- '!oidc!' sentinel — see user-store createOidcUser). Local password
-- accounts never appear here; account-merging is out of scope.

CREATE TABLE IF NOT EXISTS user_identities (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  issuer       TEXT NOT NULL,
  sub          TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- The lookup path: at callback time we SELECT ... WHERE issuer=? AND sub=?.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_issuer_sub
  ON user_identities (issuer, sub);

-- Cascade helper: when a user is deleted, drop their identities too.
CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON user_identities (user_id);
