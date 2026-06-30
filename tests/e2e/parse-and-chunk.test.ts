import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../../src/parser/parser-markdown.js';
import { chunkMarkdown } from '../../src/utils/chunk.js';

const SAMPLE = `# Project DocKhoj

A short description.

## Configuration

You can configure the embedding model.

\`\`\`typescript
const model = 'nomic-embed-text';
const size = 768;
\`\`\`

## Code Style

### Linting

We use TypeScript strict mode.
`;

describe('E2E parse-and-chunk', () => {
  it('parses and chunks a markdown doc with headings + code + sub-headings', async () => {
    const blocks = parseMarkdown(SAMPLE);
    expect(blocks.length).toBeGreaterThan(0);

    const codeBlock = blocks.find((b) => b.kind === 'code');
    expect(codeBlock).toBeDefined();
    expect(codeBlock!.headingPath).toEqual(['Project DocKhoj', 'Configuration']);
    expect(codeBlock!.text).toContain("const model = 'nomic-embed-text'");

    const chunks = await chunkMarkdown(SAMPLE, {
      maxTokens: 30,
      overlapTokens: 5,
      minTokens: 5,
      semanticSplit: false,
    });

    expect(chunks.length).toBeGreaterThan(0);

    const hasCode = chunks.some((c) => c.text.includes("const model = 'nomic-embed-text'"));
    expect(hasCode).toBe(true);

    const headingChunks = chunks.filter((c) => c.blockKind === 'heading');
    const headings = headingChunks.map((h) => h.text);
    expect(headings).toContain('Project DocKhoj');
    expect(headings).toContain('Configuration');
    expect(headings).toContain('Code Style');
    expect(headings).toContain('Linting');
  });

  it('does not split a fenced code block across chunks', async () => {
    const longCode = '```typescript\n' + 'function a() { return 1; }\n'.repeat(50) + '\n```';
    const md = `# Top\n\n${longCode}\n`;
    const chunks = await chunkMarkdown(md, {
      maxTokens: 80,
      overlapTokens: 0,
      minTokens: 5,
      semanticSplit: false,
    });
    const codeChunks = chunks.filter((c) => c.blockKind === 'code');
    expect(codeChunks.length).toBeGreaterThan(0);
    for (const cc of codeChunks) {
      const lines = cc.text.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        expect(line).toMatch(/^function a\(\) \{ return 1; \}$/);
      }
    }
  });

  it('propagates headingPath metadata across chunks', async () => {
    const md = `# Root

## A

text under A

## B

text under B

### B-deep

text under B-deep
`;
    const chunks = await chunkMarkdown(md, {
      maxTokens: 30,
      overlapTokens: 5,
      minTokens: 5,
      semanticSplit: false,
    });

    const paragraphChunks = chunks.filter((c) => c.blockKind === 'paragraph');
    expect(paragraphChunks.length).toBeGreaterThan(0);
    const paths = paragraphChunks.map((c) => c.headingPath);
    const seenPaths = new Set(paths.map((p) => p.join(' / ')));
    expect(seenPaths.size).toBeGreaterThanOrEqual(2);

    const lastParagraph = paragraphChunks[paragraphChunks.length - 1];
    expect(lastParagraph?.headingPath).toContain('B-deep');
  });
});