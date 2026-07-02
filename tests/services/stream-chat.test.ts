import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks — these run before module imports below.
const { mockEmbedText, mockSearchChunks, mockExpandHits, mockStreamRaw } = vi.hoisted(
  () => ({
    mockEmbedText: vi.fn(),
    mockSearchChunks: vi.fn(),
    mockExpandHits: vi.fn(),
    mockStreamRaw: vi.fn(),
  })
);

vi.mock('../../src/services/embed.js', () => ({
  embedText: mockEmbedText,
}));

vi.mock('../../src/services/qdrant.js', () => ({
  searchChunks: mockSearchChunks,
  expandHits: mockExpandHits,
}));

vi.mock('../../src/services/openai-api-wrapper.js', () => ({
  streamChatCompletionRaw: mockStreamRaw,
}));

import { streamChatCompletion } from '../../src/services/stream-chat.js';

// p2-p1-T20 — coverage for the stream orchestrator. We mock the three
// upstream calls (embed, search, openai stream) so the test stays
// fast and deterministic; the real OpenAI/Qdrant behavior is
// validated by the integration loop (`./restart.sh` + curl).

describe('streamChatCompletion', () => {
  beforeEach(() => {
    mockEmbedText.mockReset();
    mockSearchChunks.mockReset();
    mockExpandHits.mockReset();
    mockStreamRaw.mockReset();

    // Defaults — individual tests override as needed.
    mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
    mockSearchChunks.mockResolvedValue([
      {
        id: 'c1',
        vector: [],
        score: 0.9,
        payload: {
          chunk: 'relevant text about X',
          fileName: 'notes.md',
          filePath: 'notes.md',
          fileType: 'md',
          chunkIndex: 0,
          totalChunks: 1,
        },
      },
    ]);
    mockExpandHits.mockImplementation(async (hits: unknown) => hits);
  });

  it('yields sources first, then tokens, then done', async () => {
    async function* fakeStream() {
      yield { text: 'Hello ' };
      yield { text: 'world' };
    }
    mockStreamRaw.mockReturnValueOnce(fakeStream());

    const ac = new AbortController();
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const ev of streamChatCompletion(
      { question: 'q', sessionId: 's1' },
      ac.signal
    )) {
      events.push(ev as { type: string });
    }

    expect(events.map((e) => e.type)).toEqual(['sources', 'token', 'token', 'done']);
    expect(events[1]).toMatchObject({ type: 'token', text: 'Hello ' });
    expect(events[2]).toMatchObject({ type: 'token', text: 'world' });
  });

  it('passes question through to embedText and uses its vector for search', async () => {
    mockEmbedText.mockResolvedValueOnce([0.5, 0.5, 0.5]);
    mockSearchChunks.mockResolvedValueOnce([]);

    async function* fakeStream() {
      yield { text: 'x' };
    }
    mockStreamRaw.mockReturnValueOnce(fakeStream());

    const ac = new AbortController();
    // drain the generator
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of streamChatCompletion({ question: 'What is Y?', sessionId: 's1' }, ac.signal)) {
      /* noop */
    }

    expect(mockEmbedText).toHaveBeenCalledWith('What is Y?');
    expect(mockSearchChunks).toHaveBeenCalledWith([0.5, 0.5, 0.5], { limit: 5 });
  });

  it('uses default limit = 5 when params.limit is unset', async () => {
    mockSearchChunks.mockResolvedValueOnce([]);

    async function* fakeStream() {
      yield { text: 'x' };
    }
    mockStreamRaw.mockReturnValueOnce(fakeStream());

    const ac = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of streamChatCompletion({ question: 'q', sessionId: 's' }, ac.signal)) {
      /* noop */
    }

    expect(mockSearchChunks).toHaveBeenCalledWith(expect.any(Array), { limit: 5 });
  });

  it('passes through params.limit to searchChunks', async () => {
    mockSearchChunks.mockResolvedValueOnce([]);

    async function* fakeStream() {
      yield { text: 'x' };
    }
    mockStreamRaw.mockReturnValueOnce(fakeStream());

    const ac = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of streamChatCompletion(
      { question: 'q', sessionId: 's', limit: 12 },
      ac.signal
    )) {
      /* noop */
    }

    expect(mockSearchChunks).toHaveBeenCalledWith(expect.any(Array), { limit: 12 });
  });

  it('skips empty text chunks from the upstream stream', async () => {
    async function* fakeStream() {
      yield { text: '' };
      yield { text: 'real' };
      yield { text: '' };
    }
    mockStreamRaw.mockReturnValueOnce(fakeStream());

    const ac = new AbortController();
    const tokens: string[] = [];
    for await (const ev of streamChatCompletion({ question: 'q', sessionId: 's' }, ac.signal)) {
      if (ev.type === 'token') tokens.push(ev.text);
    }
    expect(tokens).toEqual(['real']);
  });

  it('returns silently when the upstream throws after the signal is aborted', async () => {
    // The catch branch in streamChatCompletion checks signal.aborted
    // and returns silently (no error event) when the abort caused the
    // upstream throw. The fake upstream throws the standard
    // AbortError-shape error.
    const ac = new AbortController();
    ac.abort();
    mockStreamRaw.mockImplementationOnce(() => {
      throw new Error('aborted');
    });

    const events: Array<{ type: string; message?: string }> = [];
    for await (const ev of streamChatCompletion({ question: 'q', sessionId: 's' }, ac.signal)) {
      events.push(ev as { type: string; message?: string });
    }
    // No error event because the abort caused the throw
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    // No done either — the function returned silently
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
  });

  it('emits a generic error event when the upstream throws and the signal is not aborted', async () => {
    mockStreamRaw.mockImplementationOnce(() => {
      throw new Error('upstream boom');
    });

    const ac = new AbortController();
    const events: Array<{ type: string; message?: string }> = [];
    for await (const ev of streamChatCompletion({ question: 'q', sessionId: 's' }, ac.signal)) {
      events.push(ev as { type: string; message?: string });
    }

    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/upstream boom/);
  });

  it('survives a stream that yields zero tokens (warns, but still emits done)', async () => {
    async function* fakeStream() {
      if (false) yield { text: '' };
    }
    mockStreamRaw.mockReturnValueOnce(fakeStream());

    const ac = new AbortController();
    const events: string[] = [];
    for await (const ev of streamChatCompletion({ question: 'q', sessionId: 's' }, ac.signal)) {
      events.push(ev.type);
    }
    expect(events[events.length - 1]).toBe('done');
  });

  it('builds the source list from search results in the sources event', async () => {
    mockSearchChunks.mockResolvedValueOnce([
      {
        id: 'a',
        vector: [],
        score: 0.9,
        payload: {
          chunk: 'about X',
          fileName: 'a.md',
          filePath: 'a.md',
          fileType: 'md',
          chunkIndex: 0,
          totalChunks: 1,
        },
      },
      {
        id: 'b',
        vector: [],
        score: 0.7,
        payload: {
          chunk: 'about Y',
          fileName: 'b.md',
          filePath: 'b.md',
          fileType: 'md',
          chunkIndex: 0,
          totalChunks: 1,
        },
      },
    ]);
    mockExpandHits.mockImplementationOnce(async (hits: unknown) => hits);

    async function* fakeStream() {
      yield { text: 'a' };
    }
    mockStreamRaw.mockReturnValueOnce(fakeStream());

    const ac = new AbortController();
    const events: Array<{ type: string; sources?: unknown }> = [];
    for await (const ev of streamChatCompletion({ question: 'q', sessionId: 's' }, ac.signal)) {
      events.push(ev as { type: string; sources?: unknown });
    }
    const sources = events.find((e) => e.type === 'sources') as { type: string; sources: unknown[] };
    expect(sources.sources).toHaveLength(2);
  });

  it('passes expand mode through to expandHits', async () => {
    mockExpandHits.mockResolvedValueOnce([]);

    async function* fakeStream() {
      yield { text: 'x' };
    }
    mockStreamRaw.mockReturnValueOnce(fakeStream());

    const ac = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of streamChatCompletion(
      { question: 'q', sessionId: 's', expandMode: 'sections' },
      ac.signal
    )) {
      /* noop */
    }

    expect(mockExpandHits).toHaveBeenCalledWith(expect.any(Array), { mode: 'sections' });
  });

  it('passes conversation history into the prompt (history appears in user prompt)', async () => {
    let captured: { messages: Array<{ role: string; content: string }> } | undefined;
    mockStreamRaw.mockImplementationOnce(
      (messages: Array<{ role: string; content: string }>) => {
        captured = { messages };
        async function* empty() {
          if (false) yield { text: '' };
        }
        return empty();
      }
    );

    const ac = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of streamChatCompletion(
      {
        question: 'follow-up',
        sessionId: 's',
        conversationHistory: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'first-reply' },
        ],
      },
      ac.signal
    )) {
      /* noop */
    }

    expect(captured).toBeDefined();
    const userMsg = captured!.messages.find((m) => m.role === 'user');
    expect(userMsg!.content).toContain('first');
    expect(userMsg!.content).toContain('first-reply');
  });
});