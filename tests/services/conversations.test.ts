import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { ConversationStore } from '../../src/services/conversations.js';

// T27 tests — ConversationStore against an in-memory DB. Covers the
// FR-56 acceptance: CRUD paths, message ordering, cascade delete,
// setGeneratedTitle rejecting overwrite of user-renamed titles,
// updatedAt bump on append.

describe('ConversationStore', () => {
  let db: ReturnType<typeof Database>;
  let store: ConversationStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    store = new ConversationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('conversations', () => {
    it('creates a session with default title and a UUID id', () => {
      const s = store.create();
      expect(s.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(s.title).toBe('New chat');
      expect(s.titleSource).toBe('default');
      expect(s.messageCount).toBe(0);
    });

    it('list returns sessions in updated_at DESC order', async () => {
      const a = store.create();
      await sleep(SECOND);
      const b = store.create();
      await sleep(SECOND);
      const c = store.create();
      await sleep(SECOND);
      // touch c to make it most-recently-updated
      store.bumpUpdatedAt(c.id);

      const ids = store.list().map((s) => s.id);
      expect(ids).toEqual([c.id, b.id, a.id]);
    });

    it('get returns null for an unknown id', () => {
      expect(store.get('nope')).toBeNull();
    });

    it('rename updates the title and sets title_source = user', () => {
      const s = store.create();
      const out = store.rename(s.id, 'My Project Plan');
      expect(out).not.toBeNull();
      expect(out!.title).toBe('My Project Plan');
      expect(out!.titleSource).toBe('user');
    });

    it('rename rejects empty/whitespace titles', () => {
      const s = store.create();
      expect(store.rename(s.id, '   ')).toBeNull();
      // title unchanged
      expect(store.get(s.id)!.title).toBe('New chat');
    });

    it('delete cascades to messages', () => {
      const s = store.create();
      const m1 = store.appendUserMessage(s.id, 'hello');
      const m2 = store.appendAssistantMessage(s.id, 'hi', [
        { fileName: 'a.md', filePath: 'a.md', chunk: 'x', score: 0.9 },
      ]);
      expect(store.listMessages(s.id)).toHaveLength(2);

      expect(store.delete(s.id)).toBe(true);
      expect(store.get(s.id)).toBeNull();
      // FK ON DELETE CASCADE — messages gone
      expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get()).toEqual({ c: 0 });
    });

    it('delete returns false for unknown id', () => {
      expect(store.delete('nope')).toBe(false);
    });
  });

  describe('messages', () => {
    it('appendUserMessage persists the message and bumps updatedAt', async () => {
      const s = store.create();
      const before = store.get(s.id)!.updatedAt;
      await sleep(SECOND);
      const m = store.appendUserMessage(s.id, 'hello world');
      expect(m.role).toBe('user');
      expect(m.content).toBe('hello world');
      expect(m.sources).toBeUndefined();
      const after = store.get(s.id)!;
      expect(after.updatedAt > before).toBe(true);
      expect(after.messageCount).toBe(1);
    });

    it('appendAssistantMessage persists sources as JSON', () => {
      const s = store.create();
      const sources = [
        { fileName: 'a.md', filePath: 'a.md', chunk: 'x', pageNumber: 2, headingPath: ['H1'], score: 0.9 },
      ];
      const m = store.appendAssistantMessage(s.id, 'reply', sources);
      expect(m.role).toBe('assistant');
      expect(m.sources).toEqual(sources);
      const reloaded = store.listMessages(s.id);
      expect(reloaded[0].sources).toEqual(sources);
    });

    it('listMessages returns chronological order', async () => {
      const s = store.create();
      store.appendUserMessage(s.id, 'first');
      await sleep(SECOND);
      store.appendAssistantMessage(s.id, 'second', []);
      await sleep(SECOND);
      store.appendUserMessage(s.id, 'third');

      const msgs = store.listMessages(s.id);
      expect(msgs.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('title_source rules (FR-15b)', () => {
    it('setGeneratedTitle overwrites default', () => {
      const s = store.create();
      const ok = store.setGeneratedTitle(s.id, 'LLM Generated Title');
      expect(ok).toBe(true);
      expect(store.get(s.id)!.title).toBe('LLM Generated Title');
      expect(store.get(s.id)!.titleSource).toBe('generated');
    });

    it('setGeneratedTitle overwrites a previous fallback', () => {
      const s = store.create();
      store.setFallbackTitle(s.id, '60-char prefix…');
      expect(store.get(s.id)!.titleSource).toBe('fallback');
      const ok = store.setGeneratedTitle(s.id, 'LLM Title');
      expect(ok).toBe(true);
      expect(store.get(s.id)!.title).toBe('LLM Title');
    });

    it('setGeneratedTitle rejects overwrite of user-renamed titles', () => {
      const s = store.create();
      store.rename(s.id, 'User Picked This');
      expect(store.get(s.id)!.titleSource).toBe('user');
      const ok = store.setGeneratedTitle(s.id, 'LLM Title');
      expect(ok).toBe(false);
      // title unchanged
      expect(store.get(s.id)!.title).toBe('User Picked This');
    });

    it('setGeneratedTitle rejects overwrite of an existing generated title', () => {
      // guards against duplicate concurrent title generators writing twice
      const s = store.create();
      store.setGeneratedTitle(s.id, 'First LLM Title');
      const ok = store.setGeneratedTitle(s.id, 'Second LLM Title');
      expect(ok).toBe(false);
      expect(store.get(s.id)!.title).toBe('First LLM Title');
    });

    it('setFallbackTitle overwrites default only', () => {
      const s = store.create();
      expect(store.setFallbackTitle(s.id, 'fallback…')).toBe(true);
      expect(store.get(s.id)!.titleSource).toBe('fallback');

      // Now try to overwrite the fallback with another fallback — should fail
      expect(store.setFallbackTitle(s.id, 'second fallback…')).toBe(false);
    });

    it('setFallbackTitle rejects when title is already user-renamed', () => {
      const s = store.create();
      store.rename(s.id, 'User Picked');
      expect(store.setFallbackTitle(s.id, 'fallback…')).toBe(false);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// SQLite's datetime('now') is seconds-precision. Tests that need to
// observe an updated_at change must cross a second boundary.
const SECOND = 1100;
