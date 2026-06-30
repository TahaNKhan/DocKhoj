import mammoth from 'mammoth';
import type { ParsedBlock } from './parser-types.js';

interface MammothStyle {
  type?: string;
}

interface MammothMessage {
  type: string;
  message?: string;
  style?: MammothStyle;
  styleId?: string;
  styleName?: string;
}

function deriveHeadingLevel(styleName: string | undefined): number | undefined {
  if (!styleName) return undefined;
  const m = styleName.match(/heading\s*(\d)/i);
  return m ? parseInt(m[1], 10) : undefined;
}

export async function parseDocx(filePath: string): Promise<ParsedBlock[]> {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = result.value;

  const blocks: ParsedBlock[] = [];
  const paragraphs = text.split(/\n/);
  const headingStack: { depth: number; text: string }[] = [];

  let cursor = 0;
  let pendingParagraph = '';

  const flushParagraph = (headingPath: string[]) => {
    const trimmed = pendingParagraph.trim();
    if (!trimmed) return;
    blocks.push({
      kind: 'paragraph',
      text: trimmed,
      headingPath: [...headingPath],
      startOffset: cursor - pendingParagraph.length,
      endOffset: cursor,
    });
    pendingParagraph = '';
  };

  for (const rawLine of paragraphs) {
    const line = rawLine.trimEnd();
    cursor += rawLine.length + 1;

    if (line === '') {
      flushParagraph(headingStack.map((h) => h.text));
      continue;
    }

    const styleMatch = (result.messages as MammothMessage[] | undefined)?.find(
      (m) => m.message && line.length > 0 && m.message.includes(line)
    );

    const headingLevel = deriveHeadingLevel(styleMatch?.styleName);

    if (headingLevel !== undefined) {
      flushParagraph(headingStack.map((h) => h.text));
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].depth >= headingLevel) {
        headingStack.pop();
      }
      headingStack.push({ depth: headingLevel, text: line.trim() });
      blocks.push({
        kind: 'heading',
        text: line.trim(),
        headingPath: headingStack.slice(0, -1).map((h) => h.text),
        startOffset: cursor - line.length - 1,
        endOffset: cursor,
        depth: headingLevel,
      });
      pendingParagraph = '';
      continue;
    }

    pendingParagraph = pendingParagraph
      ? `${pendingParagraph} ${line}`
      : line;
  }

  flushParagraph(headingStack.map((h) => h.text));

  return blocks;
}