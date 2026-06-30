import { describe, it, expect } from 'vitest';
import { chunkBlocks, chunkText, chunkMarkdown } from '../../src/utils/chunk.js';
import { countTokens } from '../../src/utils/chunk-tokenizer.js';

const baseOptions = {
  maxTokens: 50,
  overlapTokens: 10,
  minTokens: 5,
  softMaxTokens: 75,
  semanticSplit: false,
};

describe('chunkText (legacy shim)', () => {
  it('returns empty array for empty text', async () => {
    expect(await chunkText('', baseOptions)).toEqual([]);
  });

  it('returns empty array for whitespace-only text', async () => {
    expect(await chunkText('   \n\n  ', baseOptions)).toEqual([]);
  });

  it('returns a single chunk for short text', async () => {
    const chunks = await chunkText('hello world', baseOptions);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('hello world');
    expect(chunks[0].index).toBe(0);
  });

  it('splits long text into multiple chunks', async () => {
    const longText = Array.from({ length: 30 }, (_, i) =>
      `This is sentence number ${i}. It has enough words to fill tokens nicely.`
    ).join(' ');
    const chunks = await chunkText(longText, baseOptions);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(
        baseOptions.maxTokens + baseOptions.overlapTokens
      );
    }
  });

  it('respects minTokens by merging trailing tiny chunks', async () => {
    const text = 'alpha bravo charlie delta echo foxtrot. tiny';
    const chunks = await chunkText(text, { ...baseOptions, maxTokens: 15, minTokens: 5 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('tiny');
  });

  it('assigns sequential indices', async () => {
    const text = Array.from({ length: 50 }, (_, i) =>
      `Paragraph number ${i} with sufficient text content to exceed the budget when max is small.`
    ).join(' ');
    const chunks = await chunkText(text, { ...baseOptions, maxTokens: 20 });
    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
    });
  });
});

describe('chunkBlocks', () => {
  it('returns empty array for empty blocks', async () => {
    expect(await chunkBlocks([], baseOptions)).toEqual([]);
  });

  it('packs small blocks into one chunk', async () => {
    const blocks = [
      { kind: 'paragraph', text: 'A.', headingPath: [], startOffset: 0, endOffset: 2 },
      { kind: 'paragraph', text: 'B.', headingPath: [], startOffset: 3, endOffset: 5 },
    ];
    const chunks = await chunkBlocks(blocks, baseOptions);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('A.');
    expect(chunks[0].text).toContain('B.');
  });

  it('attaches headingPath from input blocks', async () => {
    const blocks = [
      { kind: 'paragraph', text: 'Body text under a section.', headingPath: ['Section A'], startOffset: 0, endOffset: 25 },
    ];
    const chunks = await chunkBlocks(blocks, baseOptions);
    expect(chunks[0].headingPath).toContain('Section A');
  });

  it('emits heading blocks as their own chunks', async () => {
    const blocks = [
      { kind: 'heading', text: 'Title', headingPath: [], startOffset: 0, endOffset: 5, depth: 1 },
      { kind: 'paragraph', text: 'body', headingPath: ['Title'], startOffset: 6, endOffset: 10 },
    ];
    const chunks = await chunkBlocks(blocks, baseOptions);
    expect(chunks.some((c) => c.blockKind === 'heading' && c.text === 'Title')).toBe(true);
  });

  it('attaches pageNumber metadata when provided', async () => {
    const blocks = [
      { kind: 'paragraph', text: 'Content on page one.', headingPath: [], pageNumber: 1, startOffset: 0, endOffset: 20 },
    ];
    const chunks = await chunkBlocks(blocks, baseOptions);
    expect(chunks[0].pageNumber).toBe(1);
  });
});

describe('chunkMarkdown', () => {
  it('chunks markdown while preserving heading structure', async () => {
    const md = `# H1

Some paragraph.

## H2

Another paragraph.

\`\`\`typescript
const x = 1;
\`\`\`
`;
    const chunks = await chunkMarkdown(md, baseOptions);
    expect(chunks.length).toBeGreaterThan(0);
    const headingChunks = chunks.filter((c) => c.blockKind === 'heading');
    expect(headingChunks.length).toBeGreaterThan(0);
    expect(headingChunks.some((c) => c.text === 'H1')).toBe(true);
    expect(headingChunks.some((c) => c.text === 'H2')).toBe(true);
  });

  it('does not split fenced code blocks', async () => {
    const md = `\`\`\`typescript
function alpha() { return 1; }
function beta() { return 2; }
\`\`\`
`;
    const chunks = await chunkMarkdown(md, { ...baseOptions, maxTokens: 10, minTokens: 1 });
    const codeChunks = chunks.filter((c) => c.blockKind === 'code');
    for (const chunk of codeChunks) {
      expect(chunk.text).toMatch(/^function \w+\(\)/);
    }
  });
});

void countTokens;