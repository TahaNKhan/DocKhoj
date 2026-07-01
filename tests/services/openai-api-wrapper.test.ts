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