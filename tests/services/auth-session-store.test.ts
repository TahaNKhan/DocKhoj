import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { AuthSessionStore, SESSION_TTL_DAYS } from '../../src/services/auth-session-store.js';
import { UserStore } from '../../src/services/user-store.js';

// p4-T04 tests — AuthSessionStore CRUD + rolling-expiry semantics
// against an in-memory DB. Covers FR-4 / FR-8 acceptance: session id
// is 32-byte URL-safe base64, expiry is `last_seen_at + 30 days`, and
// touch() advances the window.

describe('AuthSessionStore', () => {
  let db: ReturnType<typeof Database>;
  let store: AuthSessionStore;
  let userId: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    store = new AuthSessionStore(db);
    // Set up a real user (FK target).
    const userStore = new UserStore(db);
    const user = await userStore.createUser({
      username: 'alice',
      password: 'correcthorse123!',
      role: 'admin',
    });
    userId = user.id;
  });

  afterEach(() => {
    db.close();
  });

  it('create mints a base64url session id bound to the user', () => {
    const session = store.create(userId);
    // 32 bytes → 43 chars of base64url (no padding).
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.userId).toBe(userId);
    expect(session.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(session.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(session.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('create returns two distinct ids for two sessions', () => {
    const a = store.create(userId);
    const b = store.create(userId);
    expect(a.id).not.toBe(b.id);
  });

  it('findById returns the session while it is unexpired', () => {
    const session = store.create(userId);
    expect(store.findById(session.id)).not.toBeNull();
  });

  it('findById returns null for an unknown id', () => {
    expect(store.findById('not-a-real-id')).toBeNull();
  });

  it('findById returns null for an expired session', () => {
    // Insert a row whose expires_at is in the past.
    db.prepare(
      `INSERT INTO auth_sessions (id, user_id, last_seen_at, expires_at)
       VALUES (?, ?, datetime('now', '-2 days'), datetime('now', '-1 day'))`,
    ).run('expired-id', userId);
    expect(store.findById('expired-id')).toBeNull();
  });

  it('deleteById removes the session and returns true', () => {
    const session = store.create(userId);
    expect(store.deleteById(session.id)).toBe(true);
    expect(store.findById(session.id)).toBeNull();
  });

  it('deleteById returns false for an unknown id (idempotent)', () => {
    expect(store.deleteById('nope')).toBe(false);
  });

  it('deleteByUser removes every session belonging to that user', async () => {
    const userStore = new UserStore(db);
    const bob = await userStore.createUser({
      username: 'bob',
      password: 'correcthorse123!',
      role: 'user',
    });
    const aliceSessions = [store.create(userId), store.create(userId)];
    const bobSessions = [store.create(bob.id), store.create(bob.id)];

    const deleted = store.deleteByUser(userId);
    expect(deleted).toBe(2);

    // Alice's sessions are gone.
    for (const s of aliceSessions) expect(store.findById(s.id)).toBeNull();
    // Bob's sessions are untouched.
    for (const s of bobSessions) expect(store.findById(s.id)).not.toBeNull();
  });

  it('touch updates last_seen_at to the current time', async () => {
    const session = store.create(userId);
    const initialLastSeen = session.lastSeenAt;
    await sleep(SECOND); // cross the second boundary
    const refreshed = store.touch(session.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.lastSeenAt > initialLastSeen).toBe(true);
  });

  it('touch advances expires_at by exactly 30 days from now() within a 1-second tolerance', async () => {
    const session = store.create(userId);
    const initialExpiresAt = parseSqliteDateTime(session.expiresAt);

    // Cross the second boundary so touch()'s timestamp is clearly
    // newer than the create() timestamp (sanity check, not the
    // assertion under test).
    await sleep(SECOND);

    const beforeTouch = new Date();
    store.touch(session.id);
    const afterTouch = new Date();

    // Read the raw expires_at from the row (bypassing findById's
    // expiry filter, which is fine here because we just refreshed
    // the row).
    const row = db
      .prepare(`SELECT expires_at FROM auth_sessions WHERE id = ?`)
      .get(session.id) as { expires_at: string };
    const newExpiresAt = parseSqliteDateTime(row.expires_at);

    // The expiry must have moved forward from the initial value.
    expect(newExpiresAt.getTime()).toBeGreaterThan(initialExpiresAt.getTime());

    // It must be `now() + 30 days`, where now() is somewhere in
    // [beforeTouch, afterTouch]. Use both bounds plus 1 second of
    // slop for SQLite's second-precision truncation.
    const lowerBound = beforeTouch.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000 - 1000;
    const upperBound = afterTouch.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000 + 1000;

    expect(newExpiresAt.getTime()).toBeGreaterThanOrEqual(lowerBound);
    expect(newExpiresAt.getTime()).toBeLessThanOrEqual(upperBound);
  });

  it('touch returns null when the session id no longer exists', () => {
    expect(store.touch('does-not-exist')).toBeNull();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// SQLite datetime format is 'YYYY-MM-DD HH:MM:SS' (UTC). Convert to a
// JS Date by treating it as UTC.
function parseSqliteDateTime(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z');
}

// SQLite's datetime('now') is seconds-precision; tests that need to
// observe a timestamp change must cross a second boundary.
const SECOND = 1100;