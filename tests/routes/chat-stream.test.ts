import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';

// Phase 03 / p3-T08 — POST /api/chat/stream.
//
// Default expand mode is now `auto` (was `none` in Phase 02) per
// OD-1 / OQ-1: every chat runs the agent loop unless the caller
// overrides with `expand=none|siblings|sections`. When the LLM
// provider doesn't support `tools`, the agent loop yields a
// `tools_not_supported` event and the route falls back to
// streamChatCompletion(expand=none) (FR-22 / U11).
//
// We stub BOTH upstream streams (streamChatCompletion + the agent
// loop) so the route-level tests can drive either path or the
// fallback. The agent loop's per-iteration logic is tested in
// tests/services/agent-loop.test.ts; this file just asserts the
// SSE envelope + persistence.

// Mutable generator factories — tests reassign these per-case to
// drive either the agentic or the non-agentic path. Each is wrapped
// in a vi.fn() so we can assert on call counts. Declared inside
// vi.hoisted so the vi.mock factories (which Vitest hoists to the
// top of the file before any const/let) can reference them.
const { streamChatCompletionMock, streamAgentChatMock } = vi.hoisted(() => ({
  streamChatCompletionMock: vi.fn(),
  streamAgentChatMock: vi.fn(),
}));

vi.mock('../../src/services/stream-chat.js', () => ({
  streamChatCompletion: streamChatCompletionMock,
}));

vi.mock('../../src/services/agent-loop.js', () => ({
  streamAgentChat: streamAgentChatMock,
}));

vi.mock('../../src/services/title-generator.js', () => ({
  generateConversationTitle: vi.fn(async () => 'A Title'),
  fallbackTitle: (m: string) => m.slice(0, 60),
}));

import { migrate } from '../../src/db/migrate.js';
import { chatStreamRoutes } from '../../src/routes/chat-stream.js';

// Parse the SSE wire format into a list of {event,data} records.
function parseSse(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  for (const frame of body.split('\n\n')) {
    const trimmed = frame.trim();
    if (!trimmed) continue;
    let event = 'message';
    let data = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {
      events.push({ event, data });
    }
  }
  return events;
}

const baseSources = () => [
  { id: 'src1', payload: { fileName: 'a.md', filePath: 'a.md', chunk: 'x' }, score: 0.9 },
];

describe('POST /api/chat/stream — non-agentic path (expand=none|siblings|sections)', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    streamChatCompletionMock.mockReset();
    streamAgentChatMock.mockReset();
    // Default: a benign non-agentic stream.
    streamChatCompletionMock.mockImplementation(async function* () {
      yield { type: 'sources', sources: baseSources() };
      yield { type: 'token', text: 'Hello ' };
      yield { type: 'token', text: 'world' };
      yield { type: 'done' };
    });
    await app.register(chatStreamRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 400 when "q" is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { sessionId: 's' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an invalid sessionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'hi', sessionId: 'has spaces' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('expands=none routes to streamChatCompletion', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'hello world', expand: 'none' },
    });
    expect(res.statusCode).toBe(200);
    expect(streamChatCompletionMock).toHaveBeenCalledTimes(1);
    expect(streamAgentChatMock).not.toHaveBeenCalled();
  });

  it('expands=siblings routes to streamChatCompletion', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'hello world', expand: 'siblings' },
    });
    expect(streamChatCompletionMock).toHaveBeenCalledTimes(1);
    expect(streamAgentChatMock).not.toHaveBeenCalled();
  });

  it('emits the expected event sequence (meta, sources, tokens, done)', async () => {
    // Non-agentic: the FIRST request creates the session
    // (auto-default would route to the agent loop; we want a
    // second request to compare against the first, so make BOTH
    // non-agentic).
    const meta = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'create', expand: 'none' },
    });
    const sid = (parseSse(meta.body).find((e) => e.event === 'meta')!.data as { sessionId: string }).sessionId;
    expect(sid).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'second', sessionId: sid, expand: 'none' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const eventNames = events.map((e) => e.event);
    expect(eventNames[0]).toBe('meta');
    expect(eventNames).toContain('sources');
    expect(eventNames.filter((n) => n === 'token').length).toBeGreaterThanOrEqual(2);
    expect(eventNames).toContain('done');
    // No tool events on non-agentic.
    expect(eventNames).not.toContain('tool_call');
    expect(eventNames).not.toContain('tool_result');
    const tokens = events.filter((e) => e.event === 'token').map((e) => (e.data as { text: string }).text);
    expect(tokens.join('')).toBe('Hello world');
  });
});

describe('POST /api/chat/stream — agentic path (default expand=auto)', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof Database>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    app = Fastify({ logger: false });
    (app as unknown as { db: Database.Database }).db = db;
    await app.register(chatStreamRoutes);
    await app.ready();
    streamChatCompletionMock.mockReset();
    streamAgentChatMock.mockReset();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('no expand field routes to the agent loop (default=auto per OD-1)', async () => {
    streamAgentChatMock.mockImplementationOnce(async function* () {
      yield { type: 'sources', sources: baseSources() };
      yield { type: 'token', text: 'final answer' };
      yield { type: 'done', iterations: 1 };
    });
    await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'q' },
    });
    expect(streamAgentChatMock).toHaveBeenCalledTimes(1);
    expect(streamChatCompletionMock).not.toHaveBeenCalled();
  });

  it('expand=auto explicitly routes to the agent loop', async () => {
    streamAgentChatMock.mockImplementationOnce(async function* () {
      yield { type: 'sources', sources: baseSources() };
      yield { type: 'done', iterations: 1 };
    });
    await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'q', expand: 'auto' },
    });
    expect(streamAgentChatMock).toHaveBeenCalledTimes(1);
    expect(streamChatCompletionMock).not.toHaveBeenCalled();
  });

  it('emits tool_call + tool_result events in the correct order (FR-18)', async () => {
    streamAgentChatMock.mockImplementationOnce(async function* () {
      yield { type: 'sources', sources: baseSources() };
      yield {
        type: 'tool_call',
        name: 'get_chunk',
        arguments: { chunkId: 'c1' },
        iteration: 0,
      };
      yield {
        type: 'tool_result',
        name: 'get_chunk',
        result: { kind: 'chunks', chunks: [{ chunkId: 'c1', fileName: 'a.md', filePath: 'a.md', chunkIndex: 0, totalChunks: 1, text: 'hello' }], truncated: false },
        truncated: false,
        iteration: 0,
      };
      yield { type: 'token', text: 'final' };
      yield { type: 'done', iterations: 2 };
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'q', expand: 'auto' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const names = events.map((e) => e.event);
    expect(names).toContain('tool_call');
    expect(names).toContain('tool_result');
    // tool_call comes before tool_result and the final token.
    const toolCallIdx = names.indexOf('tool_call');
    const toolResultIdx = names.indexOf('tool_result');
    const tokenIdx = names.lastIndexOf('token');
    expect(toolCallIdx).toBeLessThan(toolResultIdx);
    expect(toolResultIdx).toBeLessThan(tokenIdx);

    const done = events.find((e) => e.event === 'done');
    expect((done!.data as { iterations: number }).iterations).toBe(2);
  });

  it('persists toolCalls on the assistant message when the agent ran tools (FR-25)', async () => {
    streamAgentChatMock.mockImplementationOnce(async function* () {
      yield { type: 'sources', sources: baseSources() };
      yield {
        type: 'tool_call',
        name: 'get_chunk',
        arguments: { chunkId: 'c1' },
        iteration: 0,
      };
      yield {
        type: 'tool_result',
        name: 'get_chunk',
        result: { kind: 'chunks', chunks: [], truncated: false },
        truncated: false,
        iteration: 0,
      };
      yield { type: 'token', text: 'final answer' };
      yield { type: 'done', iterations: 2 };
    });
    await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'q', expand: 'auto' },
    });
    // The session routes aren't registered here; read messages
    // directly from the SQLite db.
    const allMessages = db.prepare('SELECT id, role, content, tool_calls FROM messages').all() as Array<{
      role: string;
      content: string;
      tool_calls: string | null;
    }>;
    const assistant = allMessages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('final answer');
    expect(assistant!.tool_calls).not.toBeNull();
    const records = JSON.parse(assistant!.tool_calls!);
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('get_chunk');
    expect(records[0].iteration).toBe(0);
  });

  it('persists tool_calls = NULL when no tools were called', async () => {
    streamAgentChatMock.mockImplementationOnce(async function* () {
      yield { type: 'sources', sources: baseSources() };
      yield { type: 'token', text: 'plain answer' };
      yield { type: 'done', iterations: 1 };
    });
    await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'q', expand: 'auto' },
    });
    const rows = db.prepare('SELECT role, tool_calls FROM messages').all() as Array<{ role: string; tool_calls: string | null }>;
    const assistant = rows.find((r) => r.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.tool_calls).toBeNull();
  });

  it('fall back to streamChatCompletion when tools_not_supported (FR-22)', async () => {
    streamAgentChatMock.mockImplementationOnce(async function* () {
      yield { type: 'sources', sources: baseSources() };
      yield { type: 'tools_not_supported' };
    });
    streamChatCompletionMock.mockImplementationOnce(async function* () {
      yield { type: 'token', text: 'fallback answer' };
      yield { type: 'done' };
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'q', expand: 'auto' },
    });
    expect(res.statusCode).toBe(200);
    expect(streamAgentChatMock).toHaveBeenCalledTimes(1);
    expect(streamChatCompletionMock).toHaveBeenCalledTimes(1);
    const events = parseSse(res.body);
    const names = events.map((e) => e.event);
    // No tool events on the fallback path.
    expect(names).not.toContain('tool_call');
    expect(names).not.toContain('tool_result');
    const tokens = events.filter((e) => e.event === 'token').map((e) => (e.data as { text: string }).text);
    expect(tokens.join('')).toBe('fallback answer');
    // Persisted tool_calls column stays NULL on the fallback path.
    const rows = db.prepare('SELECT role, tool_calls FROM messages').all() as Array<{ role: string; tool_calls: string | null }>;
    const assistant = rows.find((r) => r.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.tool_calls).toBeNull();
  });

  it('forwards agent error events as SSE error', async () => {
    streamAgentChatMock.mockImplementationOnce(async function* () {
      yield { type: 'sources', sources: baseSources() };
      yield { type: 'error', message: 'Chat failed' };
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: { q: 'q', expand: 'auto' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const err = events.find((e) => e.event === 'error');
    expect(err).toBeDefined();
    expect((err!.data as { message: string }).message).toBe('Chat failed');
  });
});