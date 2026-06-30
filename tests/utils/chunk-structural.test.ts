import { describe, it, expect } from 'vitest';
import { chunkBlocksStructural } from '../../src/utils/chunk-structural.js';
import type { ParsedBlock } from '../../src/parser/parser-types.js';
import { countTokens } from '../../src/utils/chunk-tokenizer.js';

function p(text: string, opts: Partial<ParsedBlock> = {}): ParsedBlock {
  return {
    kind: 'paragraph',
    text,
    headingPath: [],
    startOffset: opts.startOffset ?? 0,
    endOffset: opts.endOffset ?? text.length,
    ...opts,
  };
}

function h(text: string, opts: Partial<ParsedBlock> = {}): ParsedBlock {
  return {
    kind: 'heading',
    text,
    headingPath: [],
    startOffset: opts.startOffset ?? 0,
    endOffset: opts.endOffset ?? text.length,
    depth: 1,
    ...opts,
  };
}

function c(text: string, opts: Partial<ParsedBlock> = {}): ParsedBlock {
  return {
    kind: 'code',
    text,
    headingPath: [],
    startOffset: opts.startOffset ?? 0,
    endOffset: opts.endOffset ?? text.length,
    ...opts,
  };
}

function l(text: string, opts: Partial<ParsedBlock> = {}): ParsedBlock {
  return {
    kind: 'list',
    text,
    headingPath: [],
    startOffset: opts.startOffset ?? 0,
    endOffset: opts.endOffset ?? text.length,
    ...opts,
  };
}

const opts = {
  maxTokens: 50,
  overlapTokens: 10,
  minTokens: 5,
  softMaxTokens: 75,
  semanticSplit: false,
  semanticMaxDepth: 2,
};

describe('chunkBlocksStructural', () => {
  it('returns empty array for empty blocks', () => {
    expect(chunkBlocksStructural([], opts)).toEqual([]);
  });

  it('returns one chunk for a single small block', () => {
    const blocks = [p('Hello world.')];
    const chunks = chunkBlocksStructural(blocks, opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Hello world.');
  });

  it('packs multiple small blocks into one chunk', () => {
    const blocks = [p('A.'), p('B.'), p('C.')];
    const chunks = chunkBlocksStructural(blocks, opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('A.');
    expect(chunks[0].text).toContain('B.');
    expect(chunks[0].text).toContain('C.');
  });

  it('splits when cumulative tokens exceed maxTokens', () => {
    const blocks = [
      p('A long paragraph that has plenty of words to fill tokens nicely here.'),
      p('Another paragraph with sufficient length to push us past the max token limit.'),
    ];
    const chunks = chunkBlocksStructural(blocks, opts);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(opts.maxTokens);
    }
  });

  it('attaches headingPath to chunks', () => {
    const blocks = [
      h('Section One', { headingPath: [] }),
      p('Content under section one.', { headingPath: ['Section One'] }),
      h('Section Two', { headingPath: ['Section One'] }),
      p('Content under section two.', { headingPath: ['Section One', 'Section Two'] }),
    ];
    const chunks = chunkBlocksStructural(blocks, opts);
    const paragraphChunks = chunks.filter((c) => c.blockKind === 'paragraph');
    expect(paragraphChunks.length).toBeGreaterThanOrEqual(2);
    expect(paragraphChunks[0].headingPath).toContain('Section One');
  });

  it('emits headings as their own chunks', () => {
    const blocks = [h('Title', { headingPath: [] }), p('body', { headingPath: ['Title'] })];
    const chunks = chunkBlocksStructural(blocks, opts);
    expect(chunks.some((c) => c.blockKind === 'heading' && c.text === 'Title')).toBe(true);
  });

  it('never splits inside a code block', () => {
    const codeText = [
      'function alpha() {',
      '  return 1;',
      '}',
      'function beta() {',
      '  return 2;',
      '}',
    ].join('\n');
    const blocks = [c(codeText)];
    const chunks = chunkBlocksStructural(blocks, { ...opts, maxTokens: 12, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^function \w+\(\) \{[\s\S]*?\}$/);
    }
  });

  it('does not split a list item across chunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `- item number ${i + 1} with text`).join('\n');
    const blocks = [l(lines)];
    const chunks = chunkBlocksStructural(blocks, { ...opts, maxTokens: 30, overlapTokens: 0 });
    for (const chunk of chunks) {
      for (const line of chunk.text.split('\n')) {
        if (!line.trim()) continue;
        expect(line).toMatch(/^- item number \d+ with text$/);
      }
    }
  });

  it('assigns indices sequentially starting at 0', () => {
    const blocks = Array.from({ length: 20 }, (_, i) =>
      p(`paragraph number ${i} with enough words to span multiple chunks when budget is small`)
    );
    const chunks = chunkBlocksStructural(blocks, { ...opts, maxTokens: 12, overlapTokens: 0 });
    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
    });
  });

  it('merges trailing chunk smaller than minTokens into the previous chunk', () => {
    const blocks = [
      p('alpha bravo charlie delta echo foxtrot golf hotel india juliet.'),
      p('tiny'),
    ];
    const chunks = chunkBlocksStructural(blocks, { ...opts, maxTokens: 15, overlapTokens: 0, minTokens: 5 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('tiny');
  });

  it('produces chunks with no token count exceeding maxTokens by more than overlap', () => {
    const blocks = Array.from({ length: 30 }, (_, i) =>
      p(`This is paragraph ${i}. It contains enough words to be meaningful. We want to span multiple chunks.`)
    );
    const chunks = chunkBlocksStructural(blocks, opts);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(opts.maxTokens);
    }
  });

  it('attaches pageNumber metadata from input blocks', () => {
    const blocks = [p('Page one content.', { pageNumber: 1 }), p('Page two content.', { pageNumber: 2 })];
    const chunks = chunkBlocksStructural(blocks, opts);
    const withPageNumber = chunks.filter((c) => c.pageNumber !== undefined);
    expect(withPageNumber.length).toBeGreaterThan(0);
    expect(withPageNumber[0].pageNumber).toBe(1);
  });
});