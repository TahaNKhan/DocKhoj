import fs from 'fs/promises';
import pdfParse from 'pdf-parse';
import type { ParsedBlock } from './parser-types.js';

interface PageData {
  getTextContent(): Promise<{ items: { str: string }[] }>;
}

interface PdfInfo {
  numpages?: number;
}

interface PdfParseOptions {
  pagerender?: (pageData: PageData) => Promise<string>;
}

interface PdfParseResult {
  text: string;
  numpages: number;
  info: PdfInfo;
}

const pdfParseWithOptions = pdfParse as unknown as (
  buffer: Buffer,
  options: PdfParseOptions
) => Promise<PdfParseResult>;

export async function parsePdf(filePath: string): Promise<{ blocks: ParsedBlock[]; totalPages: number }> {
  const buffer = await fs.readFile(filePath);
  const pages: { pageNumber: number; text: string }[] = [];

  const result = await pdfParseWithOptions(buffer, {
    pagerender: async (pageData: PageData) => {
      const content = await pageData.getTextContent();
      const pageText = content.items.map((item) => item.str).join(' ');
      const pageNumber = pages.length + 1;
      pages.push({ pageNumber, text: pageText });
      return pageText;
    },
  });

  const blocks: ParsedBlock[] = [];
  let cursor = 0;
  for (const page of pages) {
    const paragraphs = page.text.split(/\n\s*\n+/).filter((p) => p.trim());
    for (const para of paragraphs) {
      const text = para.trim();
      if (!text) continue;
      blocks.push({
        kind: 'paragraph',
        text,
        headingPath: [],
        pageNumber: page.pageNumber,
        startOffset: cursor,
        endOffset: cursor + text.length,
      });
      cursor += text.length;
    }
  }

  return { blocks, totalPages: result.numpages };
}