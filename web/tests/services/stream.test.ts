import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openChatStream, type StreamEvent } from '../../src/services/stream';

// p2-T20 — coverage for the client-side SSE parser used by /api/chat/stream.
// We hand-craft a ReadableStream that emits the wire-format the server
// would produce (one frame per event), then assert the events arrive in
// order, malformed frames are skipped, and abort works.

function sseStream(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(encoder.encode(f));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('openChatStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs JSON to /api/chat/stream with the body and SSE Accept header', async () => {
    fetchMock.mockResolvedValueOnce(sseStream(['event: done\ndata: {}\n\n']));

    const collected: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      const c = openChatStream({ q: 'hello', sessionId: 's1' }, {
        onEvent: (ev) => collected.push(ev),
        onClose: () => resolve(),
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/chat/stream');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ q: 'hello', sessionId: 's1' });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('text/event-stream');
    expect(collected.map((e) => e.type)).toContain('done');
  });

  it('parses meta / sources / token / done in order across a multi-frame stream', async () => {
    fetchMock.mockResolvedValueOnce(
      sseStream([
        'event: meta\ndata: {"sessionId":"s1","userMessageId":"u1"}\n\n',
        'event: sources\ndata: {"sources":[{"fileName":"a.md","filePath":"a.md","chunk":"x","score":0.9}]}\n\n',
        'event: token\ndata: {"text":"Hel"}\n\n',
        'event: token\ndata: {"text":"lo"}\n\n',
        'event: done\ndata: {"messageId":"m1"}\n\n',
      ])
    );

    const collected: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      openChatStream({ q: 'q', sessionId: 's1' }, {
        onEvent: (ev) => collected.push(ev),
        onClose: () => resolve(),
      });
    });

    expect(collected.map((e) => e.type)).toEqual([
      'meta',
      'sources',
      'token',
      'token',
      'done',
    ]);

    const meta = collected[0] as Extract<StreamEvent, { type: 'meta' }>;
    expect(meta.sessionId).toBe('s1');
    const sources = collected[1] as Extract<StreamEvent, { type: 'sources' }>;
    expect(sources.sources).toHaveLength(1);
    const tokens = collected
      .filter((e): e is Extract<StreamEvent, { type: 'token' }> => e.type === 'token')
      .map((t) => t.text);
    expect(tokens.join('')).toBe('Hello');
  });

  it('parses a title event for the title-source update path (FR-15)', async () => {
    fetchMock.mockResolvedValueOnce(
      sseStream([
        'event: title\ndata: {"sessionId":"s1","title":"Renamed by LLM"}\n\n',
      ])
    );

    const collected: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      openChatStream({ q: 'q', sessionId: 's1' }, {
        onEvent: (ev) => collected.push(ev),
        onClose: () => resolve(),
      });
    });

    const title = collected[0] as Extract<StreamEvent, { type: 'title' }>;
    expect(title.title).toBe('Renamed by LLM');
  });

  it('tolerates a malformed frame and continues parsing the next one', async () => {
    fetchMock.mockResolvedValueOnce(
      sseStream([
        // missing "event:" line → treated as default 'message' type
        'data: not-json\n\n',
        // empty data → skipped
        'event: token\n\n',
        'event: token\ndata: {"text":"ok"}\n\n',
      ])
    );

    const collected: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      openChatStream({ q: 'q' }, {
        onEvent: (ev) => collected.push(ev),
        onClose: () => resolve(),
      });
    });

    const tokens = collected.filter((e) => e.type === 'token');
    expect(tokens).toHaveLength(1);
    expect((tokens[0] as Extract<StreamEvent, { type: 'token' }>).text).toBe('ok');
  });

  it('buffers a frame split across multiple chunks', async () => {
    // Two read() calls: first sends half a frame, second completes it.
    const encoder = new TextEncoder();
    const full = 'event: token\ndata: {"text":"split"}\n\n';
    let firstChunk = true;
    const stream = new ReadableStream({
      async pull(controller) {
        if (firstChunk) {
          // Send the first ~half of the frame
          controller.enqueue(encoder.encode(full.slice(0, full.length / 2)));
          firstChunk = false;
        } else {
          controller.enqueue(encoder.encode(full.slice(full.length / 2)));
          controller.close();
        }
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );

    const collected: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      openChatStream({ q: 'q' }, {
        onEvent: (ev) => collected.push(ev),
        onClose: () => resolve(),
      });
    });

    const token = collected.find((e) => e.type === 'token') as
      | Extract<StreamEvent, { type: 'token' }>
      | undefined;
    expect(token?.text).toBe('split');
  });

  it('invokes onError with the HTTP status when the response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('upstream', { status: 503, headers: { 'Content-Type': 'text/plain' } })
    );

    const errors: unknown[] = [];
    await new Promise<void>((resolve) => {
      openChatStream({ q: 'q' }, {
        onEvent: () => {},
        onError: (e) => {
          errors.push(e);
          resolve();
        },
        onClose: () => resolve(),
      });
    });

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/503/);
  });

  it('close() aborts the fetch via the AbortController', async () => {
    let aborted = false;
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      // Return a never-resolving stream so the consumer stays parked.
      return new Promise<Response>(() => {});
    });

    const handlers = openChatStream({ q: 'q' }, { onEvent: () => {} });
    // Give the .then a tick to register the abort listener
    await new Promise((r) => setTimeout(r, 10));
    handlers.close();
    expect(aborted).toBe(true);
  });

  it('parses an error event from the server', async () => {
    fetchMock.mockResolvedValueOnce(
      sseStream(['event: error\ndata: {"message":"upstream failed"}\n\n'])
    );

    const collected: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      openChatStream({ q: 'q' }, {
        onEvent: (ev) => collected.push(ev),
        onClose: () => resolve(),
      });
    });

    const err = collected[0] as Extract<StreamEvent, { type: 'error' }>;
    expect(err.message).toBe('upstream failed');
  });

  it('parses tool_call events from the agent path (p3-T09)', async () => {
    fetchMock.mockResolvedValueOnce(
      sseStream([
        'event: tool_call\ndata: {"name":"get_chunk","arguments":{"chunkId":"c1"},"iteration":0}\n\n',
        'event: tool_call\ndata: {"name":"get_document","arguments":{"filePath":"a.md"},"iteration":1}\n\n',
      ])
    );

    const collected: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      openChatStream({ q: 'q' }, {
        onEvent: (ev) => collected.push(ev),
        onClose: () => resolve(),
      });
    });

    expect(collected).toHaveLength(2);
    const tc0 = collected[0] as Extract<StreamEvent, { type: 'tool_call' }>;
    expect(tc0.name).toBe('get_chunk');
    expect(tc0.arguments).toEqual({ chunkId: 'c1' });
    expect(tc0.iteration).toBe(0);
    const tc1 = collected[1] as Extract<StreamEvent, { type: 'tool_call' }>;
    expect(tc1.name).toBe('get_document');
    expect(tc1.iteration).toBe(1);
  });

  it('parses tool_result events with the truncated flag and result payload (p3-T09)', async () => {
    fetchMock.mockResolvedValueOnce(
      sseStream([
        'event: tool_result\ndata: {"name":"get_chunk","result":{"kind":"chunks","chunks":[],"truncated":false},"truncated":false,"iteration":0}\n\n',
      ])
    );

    const collected: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      openChatStream({ q: 'q' }, {
        onEvent: (ev) => collected.push(ev),
        onClose: () => resolve(),
      });
    });

    expect(collected).toHaveLength(1);
    const tr = collected[0] as Extract<StreamEvent, { type: 'tool_result' }>;
    expect(tr.name).toBe('get_chunk');
    expect(tr.iteration).toBe(0);
    expect(tr.truncated).toBe(false);
    expect(tr.result).toMatchObject({ kind: 'chunks' });
  });

  it('parses a full agent SSE envelope in order: meta → sources → tool_call → tool_result → token → done', async () => {
    fetchMock.mockResolvedValueOnce(
      sseStream([
        'event: meta\ndata: {"sessionId":"s1","userMessageId":"u1"}\n\n',
        'event: sources\ndata: {"sources":[{"fileName":"a.md","filePath":"a.md","chunk":"x","score":0.9}]}\n\n',
        'event: tool_call\ndata: {"name":"get_chunk","arguments":{"chunkId":"c1"},"iteration":0}\n\n',
        'event: tool_result\ndata: {"name":"get_chunk","result":{"kind":"chunks","chunks":[]},"truncated":false,"iteration":0}\n\n',
        'event: token\ndata: {"text":"answer"}\n\n',
        'event: done\ndata: {"messageId":"m1","iterations":2}\n\n',
      ])
    );

    const collected: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      openChatStream({ q: 'q' }, {
        onEvent: (ev) => collected.push(ev),
        onClose: () => resolve(),
      });
    });

    expect(collected.map((e) => e.type)).toEqual([
      'meta',
      'sources',
      'tool_call',
      'tool_result',
      'token',
      'done',
    ]);
    const done = collected.find((e) => e.type === 'done') as
      | Extract<StreamEvent, { type: 'done' }>
      | undefined;
    expect(done?.iterations).toBe(2);
  });
});