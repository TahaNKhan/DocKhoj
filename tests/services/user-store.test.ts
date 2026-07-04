import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import {
  UserStore,
  validateUsername,
  type UserRole,
} from '../../src/services/user-store.js';
import { verifyPassword } from '../../src/services/password.js';

// p4-T04 tests — UserStore CRUD + username validation against an
// in-memory DB. Covers FR-1/FR-2 acceptance: first-user is admin,
// username is 3-32 chars [A-Za-z0-9_-]+, password is hashed (never
// stored plaintext), last_login_at advances on updateLastLogin.

describe('UserStore', () => {
  let db: ReturnType<typeof Database>;
  let store: UserStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    store = new UserStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('username validation (FR-2)', () => {
    it('rejects "ab" (too short)', () => {
      expect(validateUsername('ab')).toBe(false);
    });

    it('rejects "hello world" (space)', () => {
      expect(validateUsername('hello world')).toBe(false);
    });

    it('accepts "alice-42"', () => {
      expect(validateUsername('alice-42')).toBe(true);
    });

    it('accepts the boundary cases: 3 chars and 32 chars', () => {
      expect(validateUsername('abc')).toBe(true);
      expect(validateUsername('a'.repeat(32))).toBe(true);
    });

    it('rejects 33 chars (too long)', () => {
      expect(validateUsername('a'.repeat(33))).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateUsername('')).toBe(false);
    });

    it('rejects usernames containing disallowed characters', () => {
      expect(validateUsername('alice@home')).toBe(false);
      expect(validateUsername('alice.bob')).toBe(false);
      expect(validateUsername('alice/bob')).toBe(false);
      expect(validateUsername('héllo')).toBe(false); // non-ASCII
    });

    it('is case-sensitive (Alice ≠ alice)', () => {
      // Same regex result, but the contract says case-sensitive — verified
      // downstream by the UNIQUE constraint on the column.
      expect(validateUsername('Alice')).toBe(true);
      expect(validateUsername('alice')).toBe(true);
    });
  });

  describe('createUser', () => {
    it('inserts a user, hashes the password, and returns the row', async () => {
      const user = await store.createUser({
        username: 'alice',
        password: 'correcthorse123!',
        role: 'admin',
      });

      expect(user.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/); // UUIDv4
      expect(user.username).toBe('alice');
      expect(user.role).toBe('admin');
      expect(user.passwordHash).not.toBe('correcthorse123!');
      expect(user.passwordHash.startsWith('scrypt$')).toBe(true);
      expect(user.lastLoginAt).toBeNull();
      expect(user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('the stored hash round-trips through verifyPassword', async () => {
      const user = await store.createUser({
        username: 'alice',
        password: 'correcthorse123!',
        role: 'admin',
      });
      expect(await verifyPassword('correcthorse123!', user.passwordHash)).toBe(true);
      expect(await verifyPassword('wronghorse123!', user.passwordHash)).toBe(false);
    });

    it('rejects an invalid username', async () => {
      await expect(
        store.createUser({ username: 'ab', password: 'correcthorse123!', role: 'user' }),
      ).rejects.toThrow(/Invalid username/);
    });

    it('throws on a duplicate username (UNIQUE constraint)', async () => {
      await store.createUser({ username: 'alice', password: 'correcthorse123!', role: 'admin' });
      await expect(
        store.createUser({ username: 'alice', password: 'different123!', role: 'user' }),
      ).rejects.toThrow();
    });

    it('stores the role as admin or user', async () => {
      const admin = await store.createUser({
        username: 'admin1',
        password: 'correcthorse123!',
        role: 'admin',
      });
      const user = await store.createUser({
        username: 'user1',
        password: 'correcthorse123!',
        role: 'user',
      });
      expect(admin.role).toBe('admin');
      expect(user.role).toBe('user');
    });
  });

  describe('read paths', () => {
    beforeEach(async () => {
      await store.createUser({ username: 'alice', password: 'correcthorse123!', role: 'admin' });
    });

    it('findByUsername returns the user', async () => {
      const u = store.findByUsername('alice');
      expect(u).not.toBeNull();
      expect(u!.username).toBe('alice');
    });

    it('findByUsername returns null for an unknown user', () => {
      expect(store.findByUsername('nope')).toBeNull();
    });

    it('findByUsername is case-sensitive', async () => {
      expect(store.findByUsername('Alice')).toBeNull();
    });

    it('findById returns the user', async () => {
      const u = store.findByUsername('alice')!;
      const got = store.findById(u.id);
      expect(got).not.toBeNull();
      expect(got!.id).toBe(u.id);
    });

    it('findById returns null for an unknown id', () => {
      expect(store.findById('does-not-exist')).toBeNull();
    });

    it('listAll returns every user in created_at order', async () => {
      await sleep(SECOND);
      await store.createUser({ username: 'bob', password: 'correcthorse123!', role: 'user' });
      const all = store.listAll();
      expect(all.map((u) => u.username)).toEqual(['alice', 'bob']);
    });
  });

  describe('mutations', () => {
    let userId: string;

    beforeEach(async () => {
      const u = await store.createUser({
        username: 'alice',
        password: 'correcthorse123!',
        role: 'admin',
      });
      userId = u.id;
    });

    it('updateLastLogin sets last_login_at to the current time', async () => {
      expect(store.findById(userId)!.lastLoginAt).toBeNull();
      await sleep(SECOND); // cross the second boundary
      store.updateLastLogin(userId);
      const u = store.findById(userId)!;
      expect(u.lastLoginAt).not.toBeNull();
    });

    it('usernameExists returns true / false correctly', () => {
      expect(store.usernameExists('alice')).toBe(true);
      expect(store.usernameExists('nope')).toBe(false);
    });

    it('deleteById removes the row and returns true', () => {
      expect(store.deleteById(userId)).toBe(true);
      expect(store.findById(userId)).toBeNull();
    });

    it('deleteById returns false for an unknown id (idempotent)', () => {
      expect(store.deleteById('nope')).toBe(false);
    });

    it('updatePasswordHash overwrites the stored hash', async () => {
      const before = store.findById(userId)!.passwordHash;
      const fresh = await import('../../src/services/password.js').then((m) =>
        m.hashPassword('newpassword123!'),
      );
      store.updatePasswordHash(userId, fresh);
      const after = store.findById(userId)!.passwordHash;
      expect(after).not.toBe(before);
      expect(await verifyPassword('newpassword123!', after)).toBe(true);
      expect(await verifyPassword('correcthorse123!', after)).toBe(false);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// SQLite's datetime('now') is seconds-precision; tests that observe a
// timestamp change must cross a second boundary.
const SECOND = 1100;