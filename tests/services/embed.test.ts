import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Set up env before importing
vi.stubEnv('OLLAMA_BASE_URL', 'http://ollama:11434');
vi.stubEnv('EMBEDDING_MODEL', 'nomic-embed-text');

import { embedText, embedTexts, isOllamaAvailable } from '../../src/services/embed.js';

describe('embedText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns embedding vector from API', async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: mockEmbedding }),
    });

    const result = await embedText('hello');
    expect(result).toEqual(mockEmbedding);
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    await expect(embedText('test')).rejects.toThrow('Ollama API error: 500');
  });
});

describe('embedTexts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('embeds multiple texts sequentially', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.2] }) });

    const result = await embedTexts(['hello', 'world']);
    expect(result).toEqual([[0.1], [0.2]]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns empty array for empty input', async () => {
    const result = await embedTexts([]);
    expect(result).toEqual([]);
  });
});

describe('isOllamaAvailable', () => {
  it('returns true', () => {
    expect(isOllamaAvailable()).toBe(true);
  });
});