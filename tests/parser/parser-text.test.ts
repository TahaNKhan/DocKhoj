import { describe, it, expect } from 'vitest';
import { parseText } from '../../src/parser/parser-text.js';

describe('parseText', () => {
  it('returns empty array for empty input', () => {
    expect(parseText('')).toEqual([]);
  });

  it('splits paragraphs on blank lines', () => {
    const src = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const blocks = parseText(src);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.text)).toEqual([
      'First paragraph.',
      'Second paragraph.',
      'Third paragraph.',
    ]);
  });

  it('handles CRLF line endings', () => {
    const src = 'Para A.\r\n\r\nPara B.';
    const blocks = parseText(src);
    expect(blocks).toHaveLength(2);
  });

  it('treats every block as kind=paragraph', () => {
    const blocks = parseText('one\n\ntwo');
    expect(blocks.every((b) => b.kind === 'paragraph')).toBe(true);
  });

  it('trims whitespace within each paragraph', () => {
    const blocks = parseText('  spaced   out  \n\n  next  ');
    expect(blocks[0].text).toBe('spaced   out');
    expect(blocks[1].text).toBe('next');
  });

  it('skips whitespace-only paragraphs', () => {
    const blocks = parseText('   \n\nreal\n\n   \n\nalso real');
    expect(blocks).toHaveLength(2);
  });
});