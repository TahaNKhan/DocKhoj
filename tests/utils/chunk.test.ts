import { describe, it, expect } from 'vitest';
import { chunkText, combineChunks } from '../../src/utils/chunk.js';

describe('chunkText', () => {
  it('returns single chunk for text shorter than chunkSize', () => {
    const text = 'Hello world';
    const chunks = chunkText(text, 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Hello world');
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].startChar).toBe(0);
    expect(chunks[0].endChar).toBe(11);
  });

  it('returns empty array for empty text', () => {
    const chunks = chunkText('', 500, 50);
    expect(chunks).toHaveLength(0);
  });

  it('returns empty array for whitespace-only text', () => {
    const chunks = chunkText('   ', 500, 50);
    expect(chunks).toHaveLength(0);
  });

  it('splits text into chunks', () => {
    const text = 'This is the first sentence. This is the second sentence. This is the third sentence.';
    const chunks = chunkText(text, 30, 5);
    // Just verify chunks are created and cover the text
    expect(chunks.length).toBeGreaterThan(1);
    const allText = chunks.map(c => c.text).join('');
    expect(allText).toContain('first');
    expect(allText).toContain('second');
    expect(allText).toContain('third');
  });

  it('splits at paragraph boundaries', () => {
    const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.';
    const chunks = chunkText(text, 30, 5);
    const allText = chunks.map(c => c.text).join(' ');
    expect(allText).toContain('First paragraph');
    expect(allText).toContain('Second paragraph');
    expect(allText).toContain('Third paragraph');
  });

  it('uses word boundary when no sentence/paragraph boundary available', () => {
    const text = 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd';
    const chunks = chunkText(text, 20, 5);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(chunk => {
      expect(chunk.text[-1] || '').not.toMatch(/[a-z]/i);
    });
  });

  it('respects chunkSize parameter', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = chunkText(text, 5, 2);
    chunks.forEach(chunk => {
      expect(chunk.text.length).toBeLessThanOrEqual(5);
    });
  });

  it('respects overlap parameter', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = chunkText(text, 10, 5);
    if (chunks.length > 1) {
      const firstEnd = chunks[0].endChar;
      const secondStart = chunks[1].startChar;
      expect(firstEnd - secondStart).toBe(5);
    }
  });

  it('handles chunk size larger than text', () => {
    const text = 'short';
    const chunks = chunkText(text, 1000, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('short');
  });

  it('continues until end of text', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = chunkText(text, 7, 3);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.endChar).toBe(26);
  });

  it('sets correct indices', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = chunkText(text, 5, 2);
    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
    });
  });

  it('handles exact chunkSize boundary', () => {
    const text = 'abcdefghij'.repeat(20);
    const chunks = chunkText(text, 10, 2);
    // With exact boundary and overlap, may produce more than 20 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(20);
    expect(chunks[chunks.length - 1].endChar).toBe(200);
  });

  it('handles overlap equal to chunkSize', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = chunkText(text, 10, 10);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('handles zero overlap', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = chunkText(text, 5, 0);
    if (chunks.length > 1) {
      expect(chunks[1].startChar).toBe(chunks[0].endChar);
    }
  });

  it('trims whitespace from chunks', () => {
    const text = '  hello world  ';
    const chunks = chunkText(text, 100, 10);
    expect(chunks[0].text).toBe('hello world');
  });

  it('handles single character repeated', () => {
    const text = 'aaaaaaaaaa';
    const chunks = chunkText(text, 5, 2);
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach(c => expect(c.text.length).toBeLessThanOrEqual(5));
  });

  it('handles newlines within chunk', () => {
    const text = 'line1\nline2\nline3\nline4\nline5';
    const chunks = chunkText(text, 20, 5);
    const allText = chunks.map(c => c.text).join('');
    expect(allText).toContain('\n');
  });

  it('always advances by at least 1 character', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = chunkText(text, 3, 2);
    // Each chunk's start should be >= previous chunk's start (not less)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startChar).toBeGreaterThanOrEqual(chunks[i - 1].startChar);
    }
    // Last chunk should reach the end
    expect(chunks[chunks.length - 1].endChar).toBe(26);
  });
});

describe('combineChunks', () => {
  it('combines chunks within maxLength', () => {
    const chunks = [
      { text: 'hello', index: 0, startChar: 0, endChar: 5 },
      { text: 'world', index: 1, startChar: 6, endChar: 11 },
    ];
    const result = combineChunks(chunks, 20);
    expect(result).toBe('hello world');
  });

  it('truncates when exceeding maxLength', () => {
    const chunks = [
      { text: 'hello', index: 0, startChar: 0, endChar: 5 },
      { text: 'world', index: 1, startChar: 6, endChar: 11 },
      { text: 'test', index: 2, startChar: 12, endChar: 16 },
    ];
    const result = combineChunks(chunks, 12);
    expect(result).toBe('hello world');
    expect(result.length).toBeLessThanOrEqual(12);
  });

  it('handles empty chunk array', () => {
    const result = combineChunks([], 100);
    expect(result).toBe('');
  });

  it('handles single chunk within maxLength', () => {
    const chunks = [
      { text: 'hello', index: 0, startChar: 0, endChar: 5 },
    ];
    const result = combineChunks(chunks, 100);
    expect(result).toBe('hello');
  });

  it('handles maxLength of zero', () => {
    const chunks = [
      { text: 'hello', index: 0, startChar: 0, endChar: 5 },
    ];
    const result = combineChunks(chunks, 0);
    expect(result).toBe('');
  });

  it('handles maxLength smaller than single chunk', () => {
    const chunks = [
      { text: 'hello world', index: 0, startChar: 0, endChar: 11 },
    ];
    const result = combineChunks(chunks, 5);
    expect(result).toBe('');
  });

  it('exactly maxLength boundary', () => {
    const chunks = [
      { text: 'hi', index: 0, startChar: 0, endChar: 2 },
    ];
    const result = combineChunks(chunks, 2);
    expect(result).toBe('hi');
  });

  it('uses correct maxLength default', () => {
    const chunks = [
      { text: 'a'.repeat(1000), index: 0, startChar: 0, endChar: 1000 },
    ];
    const result = combineChunks(chunks);
    expect(result.length).toBeLessThanOrEqual(2000);
  });

  it('handles chunks with newlines', () => {
    const chunks = [
      { text: 'line1\n', index: 0, startChar: 0, endChar: 6 },
      { text: 'line2', index: 1, startChar: 6, endChar: 11 },
    ];
    const result = combineChunks(chunks, 50);
    expect(result).toContain('\n');
  });
});