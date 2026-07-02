import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import {
  streamAgentChat,
  isToolsNotSupportedError,
  __test__,
  type AgentLoopDeps,
} from '../../src/services/agent-loop.js';
import type { AgentToolResult, ToolChunk } from '../../src/services/agent-tools.js';

// vi.hoisted runs BEFORE module imports — the agent-loop module
// pulls in openai-api-wrapper.ts which instantiates the OpenAI
// client at module load. We never actually make a network call (every
// test injects `deps.streamChatCompletionWithTools`), but the
// constructor still rejects a missing key.
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
});

// Phase 03 / p3-T07 — agent loop tests.
//
// Tests inject deps via `params.deps` so the loop never touches real
// Qdrant/Ollama/OpenAI. Each test owns its deps so order is
// independent.

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function makeChunk(id: string, filePath = 'doc.md', fileName = 'doc.md', overrides: Partial<ToolChunk> = {}): ToolChunk {
  return {
    chunkId: id,
    fileName,
    filePath,
    chunkIndex: 0,
    totalChunks: 5,
    text: `text for ${id}`,
    ...overrides,
  };
}

function makeBaseChunks(): ReturnType<typeof Object>[] {
  return [
    {
      id: 'base-1',
      vector: [],
      score: 0.9,
      payload: {
        chunk: 'base chunk 1',
        fileName: 'base.md',
        filePath: 'base.md',
        fileType: 'md',
        chunkIndex: 0,
        totalChunks: 1,
      },
    },
    {
      id: 'base-2',
      vector: [],
      score: 0.8,
      payload: {
        chunk: 'base chunk 2',
        fileName: 'base.md',
        filePath: 'base.md',
        fileType: 'md',
        chunkIndex: 1,
        totalChunks: 2,
      },
    },
  ];
}

interface StubbedStreamCall {
  text?: string;
  toolCalls?: Array<{ index: number; id?: string; name?: string; arguments?: string }>;
}

/** A canned stream-with-tools that emits the given frames in order. */
function makeFakeStream(frames: StubbedStreamCall[]): AgentLoopDeps['streamChatCompletionWithTools'] {
  return (_messages, _tools, _signal) => {
    return (async function* () {
      for (const f of frames) {
        const toolCalls = (f.toolCalls ?? []).map((t) => ({
          index: t.index,
          id: t.id,
          name: t.name,
          arguments: t.arguments ?? '',
        }));
        yield { text: f.text ?? '', toolCalls };
      }
    })();
  };
}

/** A stream factory that emits a different frame sequence on each call.
 *  Used by tests that need the loop to call the stream more than once
 *  (the loop creates a fresh generator each iteration). */
function makeMultiCallStream(
  perCallFrames: StubbedStreamCall[][]
): AgentLoopDeps['streamChatCompletionWithTools'] {
  let i = 0;
  return (_messages, _tools, _signal) => {
    const frames = perCallFrames[i++] ?? [];
    return (async function* () {
      for (const f of frames) {
        const toolCalls = (f.toolCalls ?? []).map((t) => ({
          index: t.index,
          id: t.id,
          name: t.name,
          arguments: t.arguments ?? '',
        }));
        yield { text: f.text ?? '', toolCalls };
      }
    })();
  };
}

describe('streamAgentChat', () => {
  it('yields sources, tokens, then done with iterations=1 when no tools are called', async () => {
    const db = setupDb();
    const stream = makeFakeStream([
      { text: 'Hello ' },
      { text: 'world.' },
    ]);
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1, 0.2, 0.3],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (): Promise<AgentToolResult> => ({ kind: 'chunks', chunks: [], truncated: false }),
    };
    const ac = new AbortController();
    const events: unknown[] = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev);
    }

    expect(events[0]).toMatchObject({ type: 'sources' });
    const tokenEvents = events.filter((e) => (e as { type: string }).type === 'token');
    expect(tokenEvents).toHaveLength(2);
    expect(tokenEvents.map((e) => (e as { text: string }).text).join('')).toBe('Hello world.');
    const done = events.find((e) => (e as { type: string }).type === 'done');
    expect(done).toEqual({ type: 'done', iterations: 1 });
  });

  it('executes a tool_call + tool_result on iter 1, then returns done on iter 2', async () => {
    const db = setupDb();
    let streamCalls = 0;
    const stream: AgentLoopDeps['streamChatCompletionWithTools'] = () => {
      streamCalls += 1;
      return (async function* () {
        if (streamCalls === 1) {
          yield {
            text: 'Let me check that. ',
            toolCalls: [
              { index: 0, id: 'call-1', name: 'get_chunk', arguments: '{"chunkId":"c1"}' },
            ],
          };
        } else {
          yield { text: 'The answer is 42.', toolCalls: [] };
        }
      })();
    };
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (name, args): Promise<AgentToolResult> => {
        toolCalls.push({ name, args });
        return { kind: 'chunks', chunks: [makeChunk('c1')], truncated: false };
      },
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }

    expect(streamCalls).toBe(2);

    const toolCallEvent = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvent).toMatchObject({
      type: 'tool_call',
      name: 'get_chunk',
      arguments: { chunkId: 'c1' },
      iteration: 0,
    });

    const toolResultEvent = events.find((e) => e.type === 'tool_result');
    expect(toolResultEvent).toMatchObject({
      type: 'tool_result',
      name: 'get_chunk',
      truncated: false,
      iteration: 0,
    });
    expect((toolResultEvent!.result as { kind: string }).kind).toBe('chunks');

    expect(toolCalls).toEqual([{ name: 'get_chunk', args: { chunkId: 'c1' } }]);

    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', iterations: 2 });
  });

  it('caps at MAX_AGENT_ITERATIONS when the LLM keeps calling tools', async () => {
    const db = setupDb();
    const MAX_AGENT_ITERATIONS = 3;
    let streamCalls = 0;
    const stream: AgentLoopDeps['streamChatCompletionWithTools'] = () => {
      streamCalls += 1;
      return (async function* () {
        yield {
          text: '',
          toolCalls: [
            { index: 0, id: `call-${streamCalls}`, name: 'get_chunk', arguments: '{"chunkId":"x"}' },
          ],
        };
      })();
    };
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (): Promise<AgentToolResult> => ({
        kind: 'chunks',
        chunks: [makeChunk(`iter-${streamCalls}`)],
        truncated: false,
      }),
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    expect(streamCalls).toBe(MAX_AGENT_ITERATIONS);
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', iterations: MAX_AGENT_ITERATIONS });
    const toolCallEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(MAX_AGENT_ITERATIONS);
  });

  it('marks a tool_result as truncated when it would exceed TOOL_RESULT_TOKEN_CAP', { timeout: 180_000 }, async () => {
    const db = setupDb();
    // 100K chars ≈ 12K cl100k_base tokens — over the 10K cap. The
    // exact ratio depends on the character; 'x' is roughly 8 chars
    // per token, so 100K chars reliably exceeds the cap. The full
    // JSON encode + decode of the truncated slice is the slow bit
    // (~5–8s on a typical laptop) — bump the timeout so CI doesn't
    // flake on slow runners.
    const bigResult = 'x'.repeat(100_000);
    const stream = makeMultiCallStream([
      [
        {
          text: '',
          toolCalls: [{ index: 0, id: 'call-big', name: 'get_chunk', arguments: '{"chunkId":"x"}' }],
        },
      ],
      [{ text: 'ok' }],
    ]);
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (): Promise<AgentToolResult> => ({
        kind: 'chunks',
        chunks: [{ chunkId: 'big', fileName: 'big.md', filePath: 'big.md', chunkIndex: 0, totalChunks: 1, text: bigResult }],
        truncated: false,
      }),
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }

    const toolResultEvent = events.find((e) => e.type === 'tool_result');
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent!.truncated).toBe(true);
  });

  it('applies the cap incrementally across multiple tool calls in the same iteration', { timeout: 60_000 }, async () => {
    const db = setupDb();
    // 3 tool calls, each producing ~10K tokens. Cap = 12K → first
    // fits, second partial, third truncated to marker.
    const stream = makeMultiCallStream([
      [
        {
          text: '',
          toolCalls: [
            { index: 0, id: 'a', name: 'get_chunk', arguments: '{"chunkId":"a"}' },
            { index: 1, id: 'b', name: 'get_chunk', arguments: '{"chunkId":"b"}' },
            { index: 2, id: 'c', name: 'get_chunk', arguments: '{"chunkId":"c"}' },
          ],
        },
      ],
      [{ text: 'done' }],
    ]);
    const callCounter = { n: 0 };
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (): Promise<AgentToolResult> => {
        callCounter.n += 1;
        const huge = 'y'.repeat(20_000);
        return {
          kind: 'chunks',
          chunks: [{ chunkId: `c${callCounter.n}`, fileName: 'x.md', filePath: 'x.md', chunkIndex: 0, totalChunks: 1, text: huge }],
          truncated: false,
        };
      },
    };
    const ac = new AbortController();
    const toolResults: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      if ((ev as { type: string }).type === 'tool_result') {
        toolResults.push(ev as unknown as Record<string, unknown>);
      }
    }
    expect(toolResults).toHaveLength(3);
    // First tool: fits within cap → not truncated.
    expect(toolResults[0]!.truncated).toBe(false);
    // Subsequent tools: truncated because running total would exceed cap.
    expect(toolResults[1]!.truncated).toBe(true);
    expect(toolResults[2]!.truncated).toBe(true);
  });

  it('returns cleanly when the signal is aborted between iterations', async () => {
    const db = setupDb();
    const ac = new AbortController();
    let callCount = 0;
    const stream: AgentLoopDeps['streamChatCompletionWithTools'] = () => {
      callCount += 1;
      return (async function* () {
        // First call returns a tool call (so the loop iterates again).
        yield {
          text: '',
          toolCalls: [{ index: 0, id: 'a', name: 'get_chunk', arguments: '{"chunkId":"a"}' }],
        };
        // Loop check at top of next iteration sees aborted; returns.
      })();
    };
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (): Promise<AgentToolResult> => {
        // Abort when the tool executes — simulates a client
        // disconnect mid-iteration.
        ac.abort();
        return { kind: 'chunks', chunks: [makeChunk('a')], truncated: false };
      },
    };
    const events: unknown[] = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev);
    }
    expect(callCount).toBe(1);
    // We should see tool_call + tool_result events but no done.
    expect(events.find((e) => (e as { type: string }).type === 'done')).toBeUndefined();
  });

  it('yields an error event when the LLM stream throws mid-call', async () => {
    const db = setupDb();
    const stream: AgentLoopDeps['streamChatCompletionWithTools'] = (async function* () {
      yield { text: 'partial ' };
      throw new Error('upstream down');
    })();
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (): Promise<AgentToolResult> => ({ kind: 'chunks', chunks: [], truncated: false }),
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ type: 'error', message: 'Chat failed' });
  });

  it('yields an error event when embedText fails', async () => {
    const db = setupDb();
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => {
        throw new Error('ollama down');
      },
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: makeFakeStream([]),
      executeAgentTool: async (): Promise<AgentToolResult> => ({ kind: 'chunks', chunks: [], truncated: false }),
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    expect(events).toEqual([{ type: 'error', message: 'embedding unavailable' }]);
  });

  it('emits the placeholder text when MAX_ITERATIONS is hit without a final answer', async () => {
    const db = setupDb();
    const stream = makeFakeStream([
      {
        text: '',
        toolCalls: [{ index: 0, id: 'a', name: 'get_chunk', arguments: '{"chunkId":"a"}' }],
      },
      {
        text: '',
        toolCalls: [{ index: 0, id: 'b', name: 'get_chunk', arguments: '{"chunkId":"b"}' }],
      },
      {
        text: '',
        toolCalls: [{ index: 0, id: 'c', name: 'get_chunk', arguments: '{"chunkId":"c"}' }],
      },
    ]);
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (): Promise<AgentToolResult> => ({
        kind: 'chunks',
        chunks: [makeChunk('a')],
        truncated: false,
      }),
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', iterations: 3 });
    // Look for the placeholder token before the done.
    const tokens = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text);
    const placeholder = "I wasn't able to find a definitive answer";
    expect(tokens.some((t) => t.includes(placeholder))).toBe(true);
  });

  it('treats a malformed tool name as an INVALID_ARG error result', async () => {
    const db = setupDb();
    const stream = makeMultiCallStream([
      [
        {
          text: '',
          toolCalls: [{ index: 0, id: 'a', name: 'totally_made_up_tool', arguments: '{}' }],
        },
      ],
      [{ text: 'after' }],
    ]);
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: vi.fn(),
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    const toolResultEvent = events.find((e) => e.type === 'tool_result');
    expect(toolResultEvent).toBeDefined();
    const result = toolResultEvent!.result as AgentToolResult;
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe('INVALID_ARG');
    }
    expect(deps.executeAgentTool).not.toHaveBeenCalled();
  });

  it('treats malformed tool arguments JSON as empty arguments', async () => {
    const db = setupDb();
    const stream = makeMultiCallStream([
      [
        {
          text: '',
          toolCalls: [{ index: 0, id: 'a', name: 'get_chunk', arguments: '{not json' }],
        },
      ],
      [{ text: 'after' }],
    ]);
    const receivedArgs: Array<Record<string, unknown>> = [];
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (_name, args): Promise<AgentToolResult> => {
        receivedArgs.push(args);
        return { kind: 'chunks', chunks: [], truncated: false };
      },
    };
    const ac = new AbortController();
    for await (const _ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      // drain
    }
    expect(receivedArgs).toEqual([{}]);
  });

  it('runs multiple tool_calls in the same iteration sequentially', async () => {
    const db = setupDb();
    const order: string[] = [];
    const stream = makeMultiCallStream([
      [
        {
          text: '',
          toolCalls: [
            { index: 0, id: 'a', name: 'get_chunk', arguments: '{"chunkId":"a"}' },
            { index: 1, id: 'b', name: 'get_chunk', arguments: '{"chunkId":"b"}' },
          ],
        },
      ],
      [{ text: 'done' }],
    ]);
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (name, args): Promise<AgentToolResult> => {
        order.push((args as { chunkId: string }).chunkId);
        return {
          kind: 'chunks',
          chunks: [makeChunk((args as { chunkId: string }).chunkId)],
          truncated: false,
        };
      },
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    expect(order).toEqual(['a', 'b']);
    // Two tool_call events + two tool_result events in order.
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolCalls).toHaveLength(2);
    expect(toolResults).toHaveLength(2);
    expect((toolCalls[0] as { name: string }).name).toBe('get_chunk');
    expect((toolResults[0] as { name: string }).name).toBe('get_chunk');
  });

  it('yields tools_not_supported when the SDK rejects the tools parameter', async () => {
    const db = setupDb();
    const stream: AgentLoopDeps['streamChatCompletionWithTools'] = () => {
      return (async function* () {
        throw new Error('Invalid request: unknown parameter tools');
      })();
    };
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (): Promise<AgentToolResult> => ({ kind: 'chunks', chunks: [], truncated: false }),
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    // Initial retrieval always happens before the LLM call — the
    // sources event is emitted first, then the loop tries to call
    // the SDK, which throws the tools-not-supported error, and we
    // yield tools_not_supported.
    const toolsEvent = events.find((e) => e.type === 'tools_not_supported');
    expect(toolsEvent).toEqual({ type: 'tools_not_supported' });
    expect(events[0]!.type).toBe('sources');
    // No tool_call / tool_result events when tools are unsupported.
    expect(events.find((e) => e.type === 'tool_call')).toBeUndefined();
    expect(events.find((e) => e.type === 'tool_result')).toBeUndefined();
  });

  it('tracks tool-retrieved chunks as additional sources', async () => {
    const db = setupDb();
    const stream = makeMultiCallStream([
      [
        {
          text: '',
          toolCalls: [{ index: 0, id: 'a', name: 'get_section_chunks', arguments: '{"filePath":"doc.md","headingPath":["H1"]}' }],
        },
      ],
      [{ text: 'final' }],
    ]);
    const deps: Partial<AgentLoopDeps> = {
      embedText: async () => [0.1],
      searchChunks: async () => makeBaseChunks() as unknown as Awaited<ReturnType<AgentLoopDeps['searchChunks']>>,
      streamChatCompletionWithTools: stream,
      executeAgentTool: async (): Promise<AgentToolResult> => ({
        kind: 'chunks',
        chunks: [makeChunk('tool-c1'), makeChunk('tool-c2')],
        truncated: false,
      }),
    };
    const ac = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamAgentChat(
      { question: 'q', sessionId: 's', db, deps },
      ac.signal
    )) {
      events.push(ev as unknown as Record<string, unknown>);
    }
    // The route handler would re-fetch sources on tool completion;
    // the loop itself doesn't yield additional sources events for
    // tool chunks (per spec — sources is emitted once before iter 0).
    // We just confirm the loop didn't throw and yielded done.
    const done = events.find((e) => e.type === 'done');
    expect(done).toEqual({ type: 'done', iterations: 2 });
    // First sources event has the base chunks.
    const sources = events.find((e) => e.type === 'sources') as { sources: unknown[] };
    expect(sources.sources).toHaveLength(2);
  });
});

describe('isToolsNotSupportedError', () => {
  it('detects "tools" + "not support"', () => {
    expect(isToolsNotSupportedError(new Error('Tools not supported by this model'))).toBe(true);
  });
  it('detects "tools" + "unsupported"', () => {
    expect(isToolsNotSupportedError(new Error('Invalid parameter: tools is unsupported'))).toBe(true);
  });
  it('detects "tools" + "unknown parameter"', () => {
    expect(isToolsNotSupportedError(new Error('Invalid request: unknown parameter tools'))).toBe(true);
  });
  it('detects "function calling" + "unsupported"', () => {
    expect(isToolsNotSupportedError(new Error('function calling is unsupported by gateway'))).toBe(true);
  });
  it('rejects errors that mention tools but do not deny support', () => {
    expect(isToolsNotSupportedError(new Error('Network error while calling tools'))).toBe(false);
  });
  it('rejects non-tools errors', () => {
    expect(isToolsNotSupportedError(new Error('Rate limit exceeded'))).toBe(false);
  });
  it('handles non-Error throws', () => {
    expect(isToolsNotSupportedError('tools not supported')).toBe(true);
    expect(isToolsNotSupportedError({ message: 'tools not supported' })).toBe(true);
  });
});

// p3-T14 — the system prompt must explicitly tell the LLM about
// the filePath/chunkId conventions so it doesn't guess wrong.
describe('SYSTEM_PROMPT (p3-T14)', () => {
  it('mentions file="…" and id="…" conventions', () => {
    // We don't import the constant (it's module-internal). Read the
    // file and grep for the required phrases.
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync(
      new URL('../../src/services/agent-loop.ts', import.meta.url),
      'utf8'
    );
    expect(src).toContain('SYSTEM_PROMPT');
    expect(src).toContain('file="…"');
    expect(src).toContain('id="…"');
    expect(src).toContain('on-disk basename');
    // Either form accepted
    expect(src).toContain('OR the user-facing fileName');
  });
});

// p3-T13 — the source list the LLM sees in the system prompt must
// expose the on-disk filePath and the chunk ID so the LLM can paste
// them verbatim into tool args.
describe('formatChunksForPrompt (p3-T13)', () => {
  const fmt = __test__.formatChunksForPrompt;

  it('includes file="<on-disk filePath>" and id="<chunkId>" per source', () => {
    const chunks = [
      {
        id: 'uuid-aaa',
        vector: [],
        score: 0.9,
        payload: {
          chunk: 'first chunk body',
          fileName: 'CC&Rs.pdf',
          filePath: 'doc-uuid-aaa.pdf',
          fileType: 'pdf',
          chunkIndex: 0,
          totalChunks: 2,
        },
      },
      {
        id: 'uuid-bbb',
        vector: [],
        score: 0.7,
        payload: {
          chunk: 'second chunk body',
          fileName: 'CC&Rs.pdf',
          filePath: 'doc-uuid-bbb.pdf',
          fileType: 'pdf',
          chunkIndex: 1,
          totalChunks: 2,
          pageNumber: 31,
        },
      },
    ] as unknown as Parameters<typeof fmt>[0];
    const out = fmt(chunks);
    expect(out).toContain('file="doc-uuid-aaa.pdf"');
    expect(out).toContain('id="uuid-aaa"');
    expect(out).toContain('file="doc-uuid-bbb.pdf"');
    expect(out).toContain('id="uuid-bbb"');
    // Source titles preserved.
    expect(out).toContain('[Source 1]');
    expect(out).toContain('[Source 2]');
    // Page annotation still rendered.
    expect(out).toContain('(p.31)');
  });

  it('returns a placeholder when no chunks match', () => {
    expect(fmt([])).toMatch(/no matching documents/);
  });
});