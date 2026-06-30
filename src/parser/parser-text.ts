import type { ParsedBlock } from './parser-types.js';

export function parseText(source: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const paragraphs = source.split(/\n\s*\n+/);

  let cursor = 0;
  for (const para of paragraphs) {
    const text = para.trim();
    if (!text) {
      cursor += para.length + 2;
      continue;
    }
    blocks.push({
      kind: 'paragraph',
      text,
      headingPath: [],
      startOffset: cursor,
      endOffset: cursor + text.length,
    });
    cursor += para.length + 2;
  }

  return blocks;
}