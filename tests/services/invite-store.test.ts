import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { migrate } from '../../src/db/migrate.js';
import { InviteStore, DEFAULT_INVITE_TTL_DAYS } from '../../src/services/invite-store.js';
import { UserStore } from '../../src/services/user-store.js';

// p4-T04 tests — InviteStore against an in-memory DB. Covers FR-10..14
// acceptance: raw token never stored, only its SHA-256 hash; the raw
// token round-trips through findByRawToken by re-hashing the input;
// listOutstanding filters out used/expired invites; markUsed is
// single-use.

describe('InviteStore', () => {
  let db: ReturnType<typeof Database>;
  let store: InviteStore;
  let creatorId: string;
  let otherCreatorId: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    store = new InviteStore(db);
    const userStore = new UserStore(db);
    const creator = await userStore.createUser({
      username: 'admin1',
      password: 'correcthorse123!',
      role: 'admin',
    });
    const other = await userStore.createUser({
      username: 'admin2',
      password: 'correcthorse123!',
      role: 'admin',
    });
    creatorId = creator.id;
    otherCreatorId = other.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('returns { id, token, expiresAt } with a base64url token and a future expiresAt', () => {
      const before = new Date();
      const invite = store.create({ createdBy: creatorId });
      const after = new Date();

      expect(invite.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/); // UUIDv4
      // 32 random bytes → 43 chars of base64url (no padding).
      expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const expires = new Date(invite.expiresAt.replace(' ', 'T') + 'Z');
      const expectedLow = new Date(before.getTime() + DEFAULT_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000 - 1000);
      const expectedHigh = new Date(after.getTime() + DEFAULT_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000 + 1000);
      expect(expires.getTime()).toBeGreaterThanOrEqual(expectedLow.getTime());
      expect(expires.getTime()).toBeLessThanOrEqual(expectedHigh.getTime());
    });

    it('honors a custom expiresInDays', () => {
      const invite = store.create({ createdBy: creatorId, expiresInDays: 30 });
      const expires = new Date(invite.expiresAt.replace(' ', 'T') + 'Z');
      const expected = Date.now() + 30 * 24 * 60 * 60 * 1000;
      // ±2s slop
      expect(Math.abs(expires.getTime() - expected)).toBeLessThan(2000);
    });

    it('stores only the SHA-256 hash of the raw token (raw token never persisted)', () => {
      const { token, id } = store.create({ createdBy: creatorId });
      const row = db.prepare(`SELECT token_hash FROM invites WHERE id = ?`).get(id) as {
        token_hash: string;
      };

      // Hash format: SHA-256 → 32 bytes → 44 chars of base64 (with padding).
      expect(row.token_hash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      // The stored hash equals SHA-256(rawToken) base64-encoded.
      const expectedHash = createHash('sha256').update(token).digest('base64');
      expect(row.token_hash).toBe(expectedHash);

      // Sanity: the raw token bytes are not in the row.
      expect(row.token_hash).not.toContain(token);
    });

    it('produces distinct tokens on each create', () => {
      const a = store.create({ createdBy: creatorId });
      const b = store.create({ createdBy: creatorId });
      expect(a.token).not.toBe(b.token);
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('findByRawToken', () => {
    it('returns the row whose token_hash matches SHA-256 of the input', () => {
      const created = store.create({ createdBy: creatorId });
      const found = store.findByRawToken(created.token);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.createdBy).toBe(creatorId);
    });

    it('returns null for an unknown token', () => {
      expect(store.findByRawToken('not-a-real-token')).toBeNull();
    });

    it('returns null for a token whose hash does not match any row', () => {
      // Valid base64url of 32 bytes but never created.
      const neverCreated = 'A'.repeat(43);
      expect(store.findByRawToken(neverCreated)).toBeNull();
    });

    it('does not reject a token whose invite is expired or used (route handler decides)', async () => {
      const created = store.create({ createdBy: creatorId });
      // Mark used.
      const userStore = new UserStore(db);
      const consumer = await userStore.createUser({
        username: 'consumer',
        password: 'correcthorse123!',
        role: 'user',
      });
      expect(store.markUsed(created.id, consumer.id)).toBe(true);
      // findByRawToken still returns the row — the route handler turns
      // the "already used" / "expired" signal into a 410 response.
      const found = store.findByRawToken(created.token);
      expect(found).not.toBeNull();
      expect(found!.usedBy).toBe(consumer.id);
    });
  });

  describe('markUsed', () => {
    it('sets used_by + used_at and returns true on first use', async () => {
      const invite = store.create({ createdBy: creatorId });
      const userStore = new UserStore(db);
      const consumer = await userStore.createUser({
        username: 'consumer',
        password: 'correcthorse123!',
        role: 'user',
      });

      const ok = store.markUsed(invite.id, consumer.id);
      expect(ok).toBe(true);

      const row = store.findByRawToken(invite.token)!;
      expect(row.usedBy).toBe(consumer.id);
      expect(row.usedAt).not.toBeNull();
    });

    it('returns false on the second markUsed call (single-use)', async () => {
      const invite = store.create({ createdBy: creatorId });
      const userStore = new UserStore(db);
      const a = await userStore.createUser({
        username: 'consumer-a',
        password: 'correcthorse123!',
        role: 'user',
      });
      const b = await userStore.createUser({
        username: 'consumer-b',
        password: 'correcthorse123!',
        role: 'user',
      });

      expect(store.markUsed(invite.id, a.id)).toBe(true);
      // Second call must NOT overwrite the first user.
      expect(store.markUsed(invite.id, b.id)).toBe(false);

      const row = store.findByRawToken(invite.token)!;
      expect(row.usedBy).toBe(a.id);
    });

    it('returns false for an unknown id', () => {
      expect(store.markUsed('does-not-exist', 'whatever')).toBe(false);
    });
  });

  describe('listOutstanding', () => {
    it('returns unused, unexpired invites only', async () => {
      // Three invite states: outstanding, used, expired.
      const outstanding = store.create({ createdBy: creatorId });
      const willBeUsed = store.create({ createdBy: creatorId });
      const willBeExpired = store.create({ createdBy: creatorId });

      // Backdate the expiry on the expired one.
      db.prepare(`UPDATE invites SET expires_at = datetime('now', '-1 day') WHERE id = ?`).run(
        willBeExpired.id,
      );

      // Mark the used one as consumed.
      const userStore = new UserStore(db);
      const consumer = await userStore.createUser({
        username: 'consumer',
        password: 'correcthorse123!',
        role: 'user',
      });
      store.markUsed(willBeUsed.id, consumer.id);

      const ids = store.listOutstanding().map((i) => i.id);
      expect(ids).toContain(outstanding.id);
      expect(ids).not.toContain(willBeUsed.id);
      expect(ids).not.toContain(willBeExpired.id);
    });

    it('returns [] when nothing is outstanding', () => {
      expect(store.listOutstanding()).toEqual([]);
    });
  });

  describe('deleteById', () => {
    it('removes the row and returns true', () => {
      const invite = store.create({ createdBy: creatorId });
      expect(store.deleteById(invite.id)).toBe(true);
      expect(store.findByRawToken(invite.token)).toBeNull();
    });

    it('returns false for an unknown id (idempotent)', () => {
      expect(store.deleteById('nope')).toBe(false);
    });
  });

  it('honors created_by across two distinct creators', () => {
    const a = store.create({ createdBy: creatorId });
    const b = store.create({ createdBy: otherCreatorId });
    expect(store.findByRawToken(a.token)!.createdBy).toBe(creatorId);
    expect(store.findByRawToken(b.token)!.createdBy).toBe(otherCreatorId);
  });
});