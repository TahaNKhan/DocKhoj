import fs from 'fs/promises';
import path from 'path';
import type { ParsedBlock, ParsedDocument } from '../parser/parser-types.js';
import { isSupportedExtension } from '../parser/parser-types.js';
import { parseMarkdown } from '../parser/parser-markdown.js';
import { parseText } from '../parser/parser-text.js';
import { parseDocx } from '../parser/parser-docx.js';
import { parsePdf } from '../parser/parser-pdf.js';
import { parserLog as log } from '../utils/logger.js';

function blocksToText(blocks: ParsedBlock[]): string {
  return blocks
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join('\n\n');
}

async function readSource(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

export async function parseFile(filePath: string): Promise<ParsedDocument> {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  log.debug({ fileName, ext }, 'Parsing file');

  let blocks: ParsedBlock[] = [];
  let totalPages: number | undefined;

  switch (ext) {
    case '.pdf': {
      const result = await parsePdf(filePath);
      blocks = result.blocks;
      totalPages = result.totalPages;
      break;
    }
    case '.docx': {
      blocks = await parseDocx(filePath);
      break;
    }
    case '.md':
    case '.markdown': {
      const source = await readSource(filePath);
      blocks = parseMarkdown(source);
      break;
    }
    case '.txt': {
      const source = await readSource(filePath);
      blocks = parseText(source);
      break;
    }
    default: {
      if (!isSupportedExtension(ext)) {
        throw new Error(`Unsupported file type: ${ext}`);
      }
      const source = await readSource(filePath);
      blocks = parseText(source);
      break;
    }
  }

  log.debug(
    { fileName, blockCount: blocks.length, totalPages },
    'File parsed'
  );

  return {
    text: blocksToText(blocks),
    blocks,
    fileName,
    fileType: ext,
    totalPages,
  };
}

export { parseMarkdown, parseText, parseDocx, parsePdf };
export type { ParsedBlock, ParsedDocument, BlockKind } from '../parser/parser-types.js';