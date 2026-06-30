import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

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

  it('throws on non-ok 4xx response without retry', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });
    await expect(embedText('test')).rejects.toThrow('Ollama API error: 400');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and succeeds on second attempt', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: [1, 2, 3] }),
      });
    const result = await embedText('retry me');
    expect(result).toEqual([1, 2, 3]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after max retries on persistent 5xx', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(embedText('persistent')).rejects.toThrow(/transient|503/);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network errors', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: [0.5] }),
      });
    const result = await embedText('network retry');
    expect(result).toEqual([0.5]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('embedTexts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for empty input', async () => {
    expect(await embedTexts([])).toEqual([]);
  });

  it('embeds multiple texts', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.2] }) });
    const result = await embedTexts(['hello', 'world']);
    expect(result).toEqual([[0.1], [0.2]]);
  });

  it('respects concurrency option', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockFetch.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { ok: true, json: async () => ({ embedding: [0.1] }) };
    });
    await embedTexts(['a', 'b', 'c', 'd', 'e', 'f'], { concurrency: 2 });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe('isOllamaAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when /api/tags returns ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    expect(await isOllamaAvailable()).toBe(true);
  });

  it('returns false when /api/tags fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    expect(await isOllamaAvailable()).toBe(false);
  });

  it('returns false when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));
    expect(await isOllamaAvailable()).toBe(false);
  });
});