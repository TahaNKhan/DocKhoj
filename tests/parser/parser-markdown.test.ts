import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../../src/parser/parser-markdown.js';

describe('parseMarkdown', () => {
  it('returns empty array for empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseMarkdown('   \n\n   ')).toEqual([]);
  });

  it('parses a heading with depth', () => {
    const blocks = parseMarkdown('# Title');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('heading');
    expect(blocks[0].text).toBe('Title');
    expect(blocks[0].depth).toBe(1);
    expect(blocks[0].headingPath).toEqual([]);
  });

  it('parses a paragraph', () => {
    const blocks = parseMarkdown('Just a paragraph.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('paragraph');
    expect(blocks[0].text).toBe('Just a paragraph.');
    expect(blocks[0].headingPath).toEqual([]);
  });

  it('tracks heading path across multiple headings', () => {
    const md = `# H1
## H2
text under H2
### H3
text under H3`;
    const blocks = parseMarkdown(md);
    const paragraphBlocks = blocks.filter((b) => b.kind === 'paragraph');
    expect(paragraphBlocks).toHaveLength(2);
    expect(paragraphBlocks[0].headingPath).toEqual(['H1', 'H2']);
    expect(paragraphBlocks[1].headingPath).toEqual(['H1', 'H2', 'H3']);
  });

  it('drops deeper headings from heading path after shallower heading', () => {
    const md = `# H1
## H2a
text A
## H2b
text B`;
    const blocks = parseMarkdown(md);
    const texts = blocks.filter((b) => b.kind === 'paragraph').map((b) => b.text);
    expect(texts).toEqual(['text A', 'text B']);
    const headings = blocks.filter((b) => b.kind === 'paragraph');
    expect(headings[0].headingPath).toEqual(['H1', 'H2a']);
    expect(headings[1].headingPath).toEqual(['H1', 'H2b']);
  });

  it('parses a fenced code block with language', () => {
    const md = '```typescript\nconst x = 1;\n```';
    const blocks = parseMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('code');
    expect(blocks[0].text).toBe('const x = 1;');
    expect(blocks[0].language).toBe('typescript');
  });

  it('parses an unordered list', () => {
    const md = `- one
- two
- three`;
    const blocks = parseMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('list');
    expect(blocks[0].text).toContain('one');
    expect(blocks[0].text).toContain('two');
    expect(blocks[0].text).toContain('three');
  });

  it('parses an ordered list', () => {
    const md = '1. first\n2. second\n3. third';
    const blocks = parseMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('list');
    expect(blocks[0].text).toContain('first');
    expect(blocks[0].text).toContain('second');
    expect(blocks[0].text).toContain('third');
  });

  it('parses a blockquote', () => {
    const md = '> quoted text';
    const blocks = parseMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('quote');
    expect(blocks[0].text).toContain('quoted text');
  });

  it('parses a table', () => {
    const md = `| col1 | col2 |
| ---- | ---- |
| a    | b    |`;
    const blocks = parseMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('table');
  });

  it('preserves offsets that monotonically increase', () => {
    const md = '# Title\n\nParagraph one.\n\nParagraph two.';
    const blocks = parseMarkdown(md);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].startOffset).toBeGreaterThanOrEqual(blocks[i - 1].endOffset);
    }
  });

  it('handles real-world markdown with mixed blocks', () => {
    const md = `# Project DocKhoj

## Overview
A self-hosted RAG tool.

## Code

\`\`\`typescript
function hello() { return 'hi'; }
\`\`\`

## Lists

- item one
- item two

## Sub
### Deep
text under deep`;
    const blocks = parseMarkdown(md);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain('heading');
    expect(kinds).toContain('paragraph');
    expect(kinds).toContain('code');
    expect(kinds).toContain('list');

    const code = blocks.find((b) => b.kind === 'code');
    expect(code?.headingPath).toContain('Project DocKhoj');
    expect(code?.headingPath).toContain('Code');
  });
});