import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  listSessions,
  getSession,
  createSession,
  renameSession,
  deleteSession,
  listMessages,
  loadActiveSessionId,
  saveActiveSessionId,
  clearActiveSessionId,
  getPinnedIds,
  togglePinnedId,
  type Conversation,
  type Message,
} from '../../src/services/sessions';

// p2-T20 — coverage for the SPA's fetch wrappers and localStorage
// helpers. The happy-dom env provides window.localStorage.

describe('sessions fetch wrappers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('listSessions fetches /api/sessions and unwraps .sessions', async () => {
    const sample: Conversation[] = [
      {
        id: 'a',
        title: 'New chat',
        titleSource: 'default',
        createdAt: '2024-01-01 00:00:00',
        updatedAt: '2024-01-01 00:00:00',
        messageCount: 0,
      },
    ];
    fetchMock.mockResolvedValueOnce(ok({ sessions: sample }));
    const out = await listSessions();
    expect(out).toEqual(sample);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions');
  });

  it('getSession fetches /api/sessions/:id (URI-encoded)', async () => {
    const c: Conversation = {
      id: 'has spaces',
      title: 't',
      titleSource: 'default',
      createdAt: '',
      updatedAt: '',
      messageCount: 0,
    };
    fetchMock.mockResolvedValueOnce(ok(c));
    await getSession('has spaces');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/has%20spaces');
  });

  it('createSession POSTs to /api/sessions', async () => {
    const c: Conversation = {
      id: 'new',
      title: 'New chat',
      titleSource: 'default',
      createdAt: '',
      updatedAt: '',
      messageCount: 0,
    };
    fetchMock.mockResolvedValueOnce(ok(c));
    const out = await createSession();
    expect(out).toEqual(c);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', { method: 'POST' });
  });

  it('renameSession PATCHes the title as JSON body', async () => {
    const c: Conversation = {
      id: 's1',
      title: 'Renamed',
      titleSource: 'user',
      createdAt: '',
      updatedAt: '',
      messageCount: 0,
    };
    fetchMock.mockResolvedValueOnce(ok(c));
    await renameSession('s1', 'Renamed');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed' }),
    });
  });

  it('deleteSession DELETEs and resolves silently on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(deleteSession('missing')).resolves.toBeUndefined();
  });

  it('deleteSession throws on a non-404 error', async () => {
    fetchMock.mockResolvedValueOnce(ok({ error: 'bad' }, 500));
    await expect(deleteSession('s1')).rejects.toThrow(/bad/);
  });

  it('listMessages fetches /api/sessions/:id/messages and unwraps .messages', async () => {
    const msgs: Message[] = [
      {
        id: 'm1',
        conversationId: 's1',
        role: 'user',
        content: 'hi',
        createdAt: '2024-01-01 00:00:00',
      },
    ];
    fetchMock.mockResolvedValueOnce(ok({ messages: msgs }));
    const out = await listMessages('s1');
    expect(out).toEqual(msgs);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/messages');
  });

  it('fetch wrappers throw with the server-supplied error message when available', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid sessionId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(getSession('!')).rejects.toThrow(/invalid sessionId/);
  });
});

describe('active session localStorage helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loadActiveSessionId returns null when nothing is stored', () => {
    expect(loadActiveSessionId()).toBeNull();
  });

  it('saveActiveSessionId persists and loadActiveSessionId reads it back', () => {
    saveActiveSessionId('s1');
    expect(loadActiveSessionId()).toBe('s1');
  });

  it('clearActiveSessionId removes the entry', () => {
    saveActiveSessionId('s1');
    clearActiveSessionId();
    expect(loadActiveSessionId()).toBeNull();
  });

  it('getPinnedIds returns an empty array when nothing is pinned', () => {
    expect(getPinnedIds()).toEqual([]);
  });

  it('togglePinnedId adds a new id and returns true', () => {
    const result = togglePinnedId('sess-1');
    expect(result).toBe(true);
    expect(getPinnedIds()).toEqual(['sess-1']);
  });

  it('togglePinnedId removes an existing id and returns false', () => {
    togglePinnedId('sess-1');
    const result = togglePinnedId('sess-1');
    expect(result).toBe(false);
    expect(getPinnedIds()).toEqual([]);
  });

  it('togglePinnedId prepends new ids (most recent pin first)', () => {
    togglePinnedId('a');
    togglePinnedId('b');
    expect(getPinnedIds()).toEqual(['b', 'a']);
  });

  it('getPinnedIds filters out non-string entries gracefully', () => {
    localStorage.setItem('dockhoj.pinned', JSON.stringify(['a', null, 3, 'b']));
    expect(getPinnedIds()).toEqual(['a', 'b']);
  });

  it('getPinnedIds returns empty array on bad JSON', () => {
    localStorage.setItem('dockhoj.pinned', '{bad json');
    expect(getPinnedIds()).toEqual([]);
  });

  it('togglePinnedId swallows errors when localStorage throws', () => {
    const orig = localStorage.setItem;
    localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
    try {
      expect(() => togglePinnedId('boom')).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
  });

  it('swallows errors when localStorage throws (private mode)', () => {
    const original = localStorage.getItem;
    // Force throw to exercise the try/catch paths.
    localStorage.getItem = () => {
      throw new Error('SecurityError');
    };
    try {
      expect(loadActiveSessionId()).toBeNull();
    } finally {
      localStorage.getItem = original;
    }

    const originalSet = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      // Should not throw — best-effort.
      expect(() => saveActiveSessionId('s1')).not.toThrow();
    } finally {
      localStorage.setItem = originalSet;
    }

    const originalRemove = localStorage.removeItem;
    localStorage.removeItem = () => {
      throw new Error('SecurityError');
    };
    try {
      expect(() => clearActiveSessionId()).not.toThrow();
    } finally {
      localStorage.removeItem = originalRemove;
    }
  });
});