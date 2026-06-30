import { describe, it, expect } from 'vitest';
import {
  countTokens,
  splitOnSentences,
  takeFirstSentences,
  takeLastSentences,
} from '../../src/utils/chunk-tokenizer.js';

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('counts more tokens for longer text', () => {
    const short = countTokens('hi');
    const long = countTokens('this is a longer sentence with more words in it');
    expect(long).toBeGreaterThan(short);
  });

  it('is monotonic in length', () => {
    const a = countTokens('a');
    const b = countTokens('ab');
    const c = countTokens('abc');
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
  });
});

describe('splitOnSentences', () => {
  it('returns empty array for empty input', () => {
    expect(splitOnSentences('')).toEqual([]);
  });

  it('splits simple sentences on period + space + capital', () => {
    const sentences = splitOnSentences('First sentence. Second sentence. Third sentence.');
    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toBe('First sentence.');
    expect(sentences[1]).toBe('Second sentence.');
    expect(sentences[2]).toBe('Third sentence.');
  });

  it('handles abbreviations without splitting', () => {
    const sentences = splitOnSentences('Mr. Smith met Dr. Jones.');
    expect(sentences.length).toBeLessThanOrEqual(2);
    expect(sentences[0]).toContain('Mr.');
    expect(sentences[0]).toContain('Dr.');
  });

  it('handles e.g. and i.e. without splitting', () => {
    const sentences = splitOnSentences('Use e.g. a for-loop. Or i.e. something else.');
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toContain('e.g.');
    expect(sentences[1]).toContain('i.e.');
  });

  it('handles U.S.A. without splitting on inner dots', () => {
    const sentences = splitOnSentences('He lived in the U.S.A. for years.');
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain('U.S.A.');
  });

  it('does not split decimal numbers', () => {
    const sentences = splitOnSentences('The value is 3.14 today.');
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toBe('The value is 3.14 today.');
  });

  it('splits on exclamation and question marks', () => {
    const sentences = splitOnSentences('Hello! How are you? I am fine.');
    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toBe('Hello!');
    expect(sentences[1]).toBe('How are you?');
    expect(sentences[2]).toBe('I am fine.');
  });

  it('handles full-width punctuation', () => {
    const sentences = splitOnSentences('你好。今天天气真好！');
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe('你好。');
    expect(sentences[1]).toBe('今天天气真好！');
  });

  it('handles paragraph breaks as sentence boundaries', () => {
    const sentences = splitOnSentences('First sentence.\nSecond sentence.');
    expect(sentences).toHaveLength(2);
  });
});

describe('takeFirstSentences', () => {
  it('returns empty when budget is 0', () => {
    expect(takeFirstSentences('hello world', 0)).toBe('');
  });

  it('returns the first N sentences within budget', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here.';
    const result = takeFirstSentences(text, 8);
    expect(result).toContain('First');
    expect(result).toContain('Second');
    expect(result).not.toContain('Third');
  });

  it('returns whole input if budget is large enough', () => {
    const text = 'Short. Bit.';
    expect(takeFirstSentences(text, 1000)).toBe(text);
  });
});

describe('takeLastSentences', () => {
  it('returns empty when budget is 0', () => {
    expect(takeLastSentences('hello world', 0)).toBe('');
  });

  it('returns the last N sentences within budget', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here.';
    const result = takeLastSentences(text, 8);
    expect(result).toContain('Third');
    expect(result).toContain('Second');
    expect(result).not.toContain('First');
  });

  it('returns whole input if budget is large enough', () => {
    const text = 'Short. Bit.';
    expect(takeLastSentences(text, 1000)).toBe(text);
  });

  it('returns nothing when budget cannot fit a whole sentence', () => {
    const text = 'Alpha bravo. Charlie delta. Echo foxtrot.';
    const result = takeLastSentences(text, 2);
    expect(result).toBe('');
  });
});