import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { UserIdentityStore } from '../../src/services/user-identity-store.js';
import { UserStore } from '../../src/services/user-store.js';

// p6-T01 tests — UserIdentityStore: insert→find round-trip, distinct
// subs under one issuer resolve to distinct users, and FK ON DELETE
// CASCADE drops the identity row when the user is removed.

describe('UserIdentityStore', () => {
  let db: ReturnType<typeof Database>;
  let store: UserIdentityStore;
  let userStore: UserStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    store = new UserIdentityStore(db);
    userStore = new UserStore(db);
  });

  afterEach(() => {
    db.close();
  });

  async function makeUser(username: string): Promise<string> {
    const user = await userStore.createUser({
      username,
      password: 'correcthorse123!',
      role: 'user',
    });
    return user.id;
  }

  it('link then findUserIdByIssuerSub round-trips the user_id', async () => {
    const userId = await makeUser('alice');
    store.link(userId, 'https://idp.example', 'sub-123');
    expect(store.findUserIdByIssuerSub('https://idp.example', 'sub-123')).toBe(userId);
  });

  it('findUserIdByIssuerSub returns null for an unseen (issuer, sub)', () => {
    expect(store.findUserIdByIssuerSub('https://idp.example', 'never-seen')).toBeNull();
  });

  it('two different subs under the same issuer resolve to different users', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    store.link(aliceId, 'https://idp.example', 'sub-alice');
    store.link(bobId, 'https://idp.example', 'sub-bob');

    expect(store.findUserIdByIssuerSub('https://idp.example', 'sub-alice')).toBe(aliceId);
    expect(store.findUserIdByIssuerSub('https://idp.example', 'sub-bob')).toBe(bobId);
  });

  it('the (issuer, sub) UNIQUE index rejects a second link to a different user', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    store.link(aliceId, 'https://idp.example', 'same-sub');
    // Same (issuer, sub) again but a different user — must collide.
    expect(() => store.link(bobId, 'https://idp.example', 'same-sub')).toThrow();
  });

  it('deleting the user cascades to the identity row', async () => {
    const userId = await makeUser('alice');
    store.link(userId, 'https://idp.example', 'sub-123');
    expect(store.findUserIdByIssuerSub('https://idp.example', 'sub-123')).toBe(userId);

    userStore.deleteById(userId);

    expect(store.findUserIdByIssuerSub('https://idp.example', 'sub-123')).toBeNull();
    const row = db
      .prepare(`SELECT 1 AS x FROM user_identities WHERE user_id = ?`)
      .get(userId);
    expect(row).toBeUndefined();
  });
});
