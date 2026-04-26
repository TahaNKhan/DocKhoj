import fs from 'fs/promises';
import path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

export interface ParsedDocument {
  text: string;
  fileName: string;
  fileType: string;
}

export async function parseFile(filePath: string): Promise<ParsedDocument> {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  let text = '';

  switch (ext) {
    case '.pdf':
      text = await parsePdf(filePath);
      break;
    case '.docx':
      text = await parseDocx(filePath);
      break;
    case '.txt':
    case '.md':
    case '.markdown':
      text = await fs.readFile(filePath, 'utf-8');
      break;
    default:
      // Try as plain text
      try {
        text = await fs.readFile(filePath, 'utf-8');
      } catch {
        throw new Error(`Unsupported file type: ${ext}`);
      }
  }

  // Clean up the text
  text = text.replace(/\s+/g, ' ').trim();

  return {
    text,
    fileName,
    fileType: ext,
  };
}

async function parsePdf(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  const parsed = await pdfParse(data);
  return parsed.text;
}

async function parseDocx(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

export function getSupportedExtensions(): string[] {
  return ['.pdf', '.docx', '.txt', '.md', '.markdown'];
}
