import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchStatus, formatContextSize } from '../../src/services/status';

describe('formatContextSize', () => {
  it('renders sub-thousand token counts as raw numbers', () => {
    expect(formatContextSize(512)).toBe('512');
    expect(formatContextSize(999)).toBe('999');
  });

  it('renders thousands as e.g. "8K", "16K", "128K", "200K"', () => {
    expect(formatContextSize(8_000)).toBe('8K');
    expect(formatContextSize(16_385)).toBe('16K');
    expect(formatContextSize(128_000)).toBe('128K');
    expect(formatContextSize(200_000)).toBe('200K');
  });

  it('renders millions as e.g. "1M", "1.5M"', () => {
    expect(formatContextSize(1_000_000)).toBe('1M');
    expect(formatContextSize(1_500_000)).toBe('1.5M');
  });

  it('returns "" for null (unknown)', () => {
    expect(formatContextSize(null)).toBe('');
  });
});

describe('fetchStatus', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the parsed status body on 200', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          chunks: 298,
          ollamaAvailable: true,
          llmModel: 'gpt-4o',
          llmContextSize: 128_000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const status = await fetchStatus();
    expect(status).toEqual({
      chunks: 298,
      ollamaAvailable: true,
      llmModel: 'gpt-4o',
      llmContextSize: 128_000,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/status');
  });

  it('passes through llmContextSize=null when the server does not know the size', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          chunks: 0,
          ollamaAvailable: true,
          llmModel: 'some-obscure-xyz',
          llmContextSize: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    expect((await fetchStatus()).llmContextSize).toBeNull();
  });

  it('throws on non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"down"}', { status: 503 }));
    await expect(fetchStatus()).rejects.toThrow(/503/);
  });
});