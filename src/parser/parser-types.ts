export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'code'
  | 'list'
  | 'table'
  | 'quote'
  | 'page-break'
  | 'other';

export interface ParsedBlock {
  kind: BlockKind;
  text: string;
  headingPath: string[];
  pageNumber?: number;
  startOffset: number;
  endOffset: number;
  depth?: number;
  language?: string;
}

export interface ParsedDocument {
  text: string;
  blocks: ParsedBlock[];
  fileName: string;
  fileType: string;
  totalPages?: number;
}

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.markdown'] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export function isSupportedExtension(ext: string): ext is SupportedExtension {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}