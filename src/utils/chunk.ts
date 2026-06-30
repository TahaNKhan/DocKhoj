import type { BlockKind, ParsedBlock } from '../parser/parser-types.js';
import { parseText } from '../parser/parser-text.js';
import { parseMarkdown } from '../parser/parser-markdown.js';
import { chunkBlocksStructural } from './chunk-structural.js';
import { applySemanticSplitToChunks, type EmbedFn } from './chunk-semantic.js';
import { DEFAULT_CHUNK_OPTIONS } from './chunk-types.js';
import type { Chunk } from './chunk-types.js';

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
  minTokens?: number;
  softMaxTokens?: number;
  semanticSplit?: boolean;
  semanticMaxDepth?: number;
}

export interface ChunkBlocksOptions extends ChunkOptions {
  embedFn?: EmbedFn;
}

function resolveOptions(options: ChunkBlocksOptions): Required<Omit<ChunkOptions, 'semanticSplit' | 'embedFn'>> & {
  semanticSplit: boolean;
  embedFn?: EmbedFn;
} {
  return {
    maxTokens: options.maxTokens ?? DEFAULT_CHUNK_OPTIONS.maxTokens,
    overlapTokens: options.overlapTokens ?? DEFAULT_CHUNK_OPTIONS.overlapTokens,
    minTokens: options.minTokens ?? DEFAULT_CHUNK_OPTIONS.minTokens,
    softMaxTokens: options.softMaxTokens ?? DEFAULT_CHUNK_OPTIONS.softMaxTokens,
    semanticSplit: options.semanticSplit ?? DEFAULT_CHUNK_OPTIONS.semanticSplit,
    semanticMaxDepth: options.semanticMaxDepth ?? DEFAULT_CHUNK_OPTIONS.semanticMaxDepth,
    embedFn: options.embedFn,
  };
}

export async function chunkBlocks(
  blocks: ParsedBlock[],
  options: ChunkBlocksOptions = {}
): Promise<Chunk[]> {
  const opts = resolveOptions(options);
  const structural = chunkBlocksStructural(blocks, opts);
  if (opts.semanticSplit && opts.embedFn) {
    return applySemanticSplitToChunks(structural, { ...opts, embedFn: opts.embedFn });
  }
  return structural;
}

export async function chunkText(
  text: string,
  options: ChunkBlocksOptions & { defaultKind?: BlockKind } = {}
): Promise<Chunk[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const defaultKind: BlockKind = options.defaultKind ?? 'paragraph';
  let blocks: ParsedBlock[];
  if (defaultKind === 'paragraph') {
    blocks = parseText(trimmed);
    if (blocks.length === 0) {
      blocks = [{
        kind: 'paragraph',
        text: trimmed,
        headingPath: [],
        startOffset: 0,
        endOffset: trimmed.length,
      }];
    }
  } else {
    blocks = [{
      kind: defaultKind,
      text: trimmed,
      headingPath: [],
      startOffset: 0,
      endOffset: trimmed.length,
    }];
  }

  return chunkBlocks(blocks, options);
}

export async function chunkMarkdown(
  source: string,
  options: ChunkBlocksOptions = {}
): Promise<Chunk[]> {
  const blocks = parseMarkdown(source);
  return chunkBlocks(blocks, options);
}

export type { Chunk };
export type { EmbedFn } from './chunk-semantic.js';