import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCreate, mockRetrieve } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockRetrieve: vi.fn(),
}));

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
});

vi.mock('openai', () => ({
  default: function () {
    return {
      chat: {
        completions: {
          create: mockCreate,
        },
      },
      models: {
        retrieve: mockRetrieve,
      },
    };
  },
}));

import {
  createChatCompletion,
  chatWithDocuments,
  streamChatCompletionRaw,
  streamChatCompletionWithTools,
  getLlmContextSize,
} from '../../src/services/openai-api-wrapper.js';

describe('createChatCompletion', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns the message content from the first choice', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'the answer' } }],
    });
    const out = await createChatCompletion([
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toBe('the answer');
  });

  it('strips  think tags from the response', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        { message: { content: 'the actual answer' } },
      ],
    });
    const out = await createChatCompletion([
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toContain('the actual answer');
  });

  it('throws an error when the API call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('upstream down'));
    await expect(
      createChatCompletion([{ role: 'user', content: 'hi' }])
    ).rejects.toThrow(/Failed to generate/);
  });
});

describe('chatWithDocuments', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns an answer with source previews', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'the answer based on docs' } }],
    });
    const response = await chatWithDocuments('What is X?', [
      {
        fileName: 'notes.md',
        filePath: 'abc.md',
        chunk: 'Some content about X. '.repeat(50),
        score: 0.9,
      },
    ]);

    expect(response.answer).toBe('the answer based on docs');
    expect(response.sources).toHaveLength(1);
    expect(response.sources[0].fileName).toBe('notes.md');
    expect(response.sources[0].text.endsWith('...') || response.sources[0].text.length <= 200).toBe(true);
  });
});

describe('streamChatCompletionRaw', () => {
  beforeEach(() => mockCreate.mockReset());

  it('yields text chunks in order', async () => {
    // Async iterator that yields the same shape OpenAI returns for
    // stream=true. The wrapper extracts choices[0].delta.content.
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'Hel' } }] };
      yield { choices: [{ delta: { content: 'lo' } }] };
      yield { choices: [{ delta: { content: ' world' } }] };
    }
    mockCreate.mockResolvedValueOnce(fakeStream());

    const ac = new AbortController();
    const collected: string[] = [];
    for await (const ev of streamChatCompletionRaw(
      [{ role: 'user', content: 'hi' }],
      ac.signal
    )) {
      collected.push(ev.text);
    }
    expect(collected.join('')).toBe('Hello world');
    // sanity: stream:true was passed
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true }),
      expect.objectContaining({ signal: ac.signal })
    );
  });

  it('skips chunks with empty delta content', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'a' } }] };
      yield { choices: [{ delta: { content: '' } }] };
      yield { choices: [{ delta: {} }] };
      yield { choices: [{ delta: { content: 'b' } }] };
    }
    mockCreate.mockResolvedValueOnce(fakeStream());
    const ac = new AbortController();
    const collected: string[] = [];
    for await (const ev of streamChatCompletionRaw([], ac.signal)) collected.push(ev.text);
    expect(collected.join('')).toBe('ab');
  });
});

describe('streamChatCompletionWithTools', () => {
  beforeEach(() => mockCreate.mockReset());

  it('yields one frame per OpenAI chunk with text + accumulated toolCalls', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'Hel' } }] };
      yield { choices: [{ delta: { content: 'lo ' } }] };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', function: { name: 'get_chunk', arguments: '{"chunk' } },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'Id":"x"}' } }],
            },
          },
        ],
      };
      yield { choices: [{ delta: { content: ' done' } }] };
    }
    mockCreate.mockResolvedValueOnce(fakeStream());

    const ac = new AbortController();
    const frames: Array<{ text: string; toolCalls: ReturnType<typeof Object>[] }> = [];
    for await (const ev of streamChatCompletionWithTools(
      [{ role: 'user', content: 'hi' }],
      [
        {
          type: 'function',
          function: { name: 'get_chunk', description: 'd', parameters: { type: 'object', properties: {} } },
        },
      ],
      ac.signal
    )) {
      frames.push({ text: ev.text, toolCalls: ev.toolCalls as unknown as ReturnType<typeof Object>[] });
    }

    // 5 frames total.
    expect(frames).toHaveLength(5);
    // text deltas are passed through.
    expect(frames.map((f) => f.text)).toEqual(['Hel', 'lo ', '', '', ' done']);
    // tool_calls accumulator empty until the third frame, then partial, then complete.
    expect(frames[0]!.toolCalls).toEqual([]);
    expect(frames[1]!.toolCalls).toEqual([]);
    expect(frames[2]!.toolCalls).toEqual([
      { index: 0, id: 'call_a', name: 'get_chunk', arguments: '{"chunk' },
    ]);
    expect(frames[3]!.toolCalls).toEqual([
      { index: 0, id: 'call_a', name: 'get_chunk', arguments: '{"chunkId":"x"}' },
    ]);
    // Last frame still carries the tool calls (in case more chunks arrive).
    expect(frames[4]!.toolCalls).toEqual([
      { index: 0, id: 'call_a', name: 'get_chunk', arguments: '{"chunkId":"x"}' },
    ]);
  });

  it('accumulates multiple tool_calls in one chunk + across chunks', async () => {
    async function* fakeStream() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c0', function: { name: 'foo', arguments: '{"a":' } },
                { index: 1, id: 'c1', function: { name: 'bar', arguments: '{"b"' } },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '1}' } },
                { index: 1, function: { arguments: ':2}' } },
              ],
            },
          },
        ],
      };
    }
    mockCreate.mockResolvedValueOnce(fakeStream());
    const ac = new AbortController();
    const finalToolCalls: Array<{ index: number; id?: string; name?: string; arguments: string }> = [];
    for await (const ev of streamChatCompletionWithTools([], [], ac.signal)) {
      // Track the last accumulation we see.
      for (const tc of ev.toolCalls) {
        finalToolCalls[tc.index] = { ...tc };
      }
    }
    expect(finalToolCalls).toHaveLength(2);
    expect(finalToolCalls[0]).toEqual({ index: 0, id: 'c0', name: 'foo', arguments: '{"a":1}' });
    expect(finalToolCalls[1]).toEqual({ index: 1, id: 'c1', name: 'bar', arguments: '{"b":2}' });
  });

  it('returns cleanly when signal is aborted between chunks', async () => {
    const ac = new AbortController();
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'a' } }] };
      // Simulate slow chunk — caller aborts during the wait.
      yield { choices: [{ delta: { content: 'b' } }] };
    }
    mockCreate.mockResolvedValueOnce(fakeStream());

    const collected: string[] = [];
    for await (const ev of streamChatCompletionWithTools([], [], ac.signal)) {
      collected.push(ev.text);
      ac.abort();
    }
    // After abort we exit the loop on the next iteration's check.
    // We expect at most one chunk to land before returning.
    expect(collected.length).toBeLessThanOrEqual(1);
    expect(ac.signal.aborted).toBe(true);
  });

  it('passes stream:true + tools + signal to openai.chat.completions.create', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'hello' } }] };
    }
    mockCreate.mockResolvedValueOnce(fakeStream());

    const ac = new AbortController();
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'foo', description: 'd', parameters: { type: 'object' as const, properties: {} } },
      },
    ];
    for await (const _ev of streamChatCompletionWithTools(
      [{ role: 'user', content: 'q' }],
      tools,
      ac.signal
    )) {
      // consume one frame
      break;
    }

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true, tools }),
      expect.objectContaining({ signal: ac.signal })
    );
  });

  it('a stream with no tool_calls yields toolCalls: [] throughout', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'plain text only' } }] };
    }
    mockCreate.mockResolvedValueOnce(fakeStream());

    const ac = new AbortController();
    const frames: Array<{ text: string; toolCalls: unknown[] }> = [];
    for await (const ev of streamChatCompletionWithTools([], [], ac.signal)) {
      frames.push({ text: ev.text, toolCalls: ev.toolCalls });
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]!.text).toBe('plain text only');
    expect(frames[0]!.toolCalls).toEqual([]);
  });

  it('lets the caller observe a `tools not supported` SDK error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('tools param not supported'));
    const ac = new AbortController();
    await expect(async () => {
      for await (const _ev of streamChatCompletionWithTools([], [], ac.signal)) {
        // unreachable
      }
    }).rejects.toThrow(/tools param not supported/);
  });
});

describe('getLlmContextSize', () => {
  // The probe caches at module level. Each test gets a fresh module
  // instance via vi.resetModules so the cache doesn't leak between
  // cases (and so the model id / env doesn't matter across re-imports).
  beforeEach(() => {
    mockRetrieve.mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  async function loadFreshModule() {
    return import('../../src/services/openai-api-wrapper.js');
  }

  function setModelEnv(name: string | undefined) {
    if (name === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = name;
  }

  it('reads context_length from the API response (Ollama)', async () => {
    setModelEnv('llama3.1:8b');
    mockRetrieve.mockResolvedValueOnce({ context_length: 128_000 });
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBe(128_000);
  });

  it('reads max_context_length (LM Studio)', async () => {
    setModelEnv('llama3.1');
    mockRetrieve.mockResolvedValueOnce({ max_context_length: 32_768 });
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBe(32_768);
  });

  it('reads max_model_len (vLLM)', async () => {
    setModelEnv('mistral');
    mockRetrieve.mockResolvedValueOnce({ max_model_len: 8_192 });
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBe(8_192);
  });

  it('falls back to a built-in size table when the API does not return a size', async () => {
    setModelEnv('gpt-4o');
    // OpenAI doesn't expose context window on /models — comes back empty.
    mockRetrieve.mockResolvedValueOnce({});
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBe(128_000);
  });

  it('falls back to the built-in size table when the probe throws', async () => {
    setModelEnv('claude-3-5-sonnet-latest');
    mockRetrieve.mockRejectedValueOnce(new Error('network down'));
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBe(200_000);
  });

  it('returns null when neither the API nor the table know the model', async () => {
    setModelEnv('some-obscure-model-xyz');
    mockRetrieve.mockRejectedValueOnce(new Error('model not found'));
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBeNull();
  });

  it('caches the result so the probe runs at most once', async () => {
    setModelEnv('gpt-4o');
    mockRetrieve.mockResolvedValueOnce({ context_length: 128_000 });
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBe(128_000);
    expect(await getLlmContextSize()).toBe(128_000);
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  it('skips fields that are not positive integers', async () => {
    setModelEnv('gpt-4o');
    mockRetrieve.mockResolvedValueOnce({
      context_length: 0,
      max_context_length: -5,
      max_model_len: 16_384,
    });
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBe(16_384);
  });

  it('uses LLM_CONTEXT_SIZE env override and skips the API probe', async () => {
    setModelEnv('MiniMax-M3');
    process.env.LLM_CONTEXT_SIZE = '262144';
    // The probe should NOT be called — the override short-circuits it.
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBe(262_144);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('ignores invalid LLM_CONTEXT_SIZE values and falls through', async () => {
    setModelEnv('gpt-4o');
    process.env.LLM_CONTEXT_SIZE = 'not-a-number';
    mockRetrieve.mockResolvedValueOnce({ context_length: 128_000 });
    const { getLlmContextSize } = await loadFreshModule();
    expect(await getLlmContextSize()).toBe(128_000);
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  it('LLM_CONTEXT_SIZE=0 falls through (only positive ints count)', async () => {
    // Use a model that isn't in the known-size table so the only
    // sources of context size are the probe and the override.
    setModelEnv('some-obscure-model-xyz');
    process.env.LLM_CONTEXT_SIZE = '0';
    mockRetrieve.mockResolvedValueOnce({});
    const { getLlmContextSize } = await loadFreshModule();
    // No probe value, invalid override, no known-table entry → null.
    expect(await getLlmContextSize()).toBeNull();
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });
});