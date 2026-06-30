import type { BlockKind, ParsedBlock } from '../parser/parser-types.js';

export interface ChunkMetadata {
  blockKind: BlockKind;
  headingPath: string[];
  pageNumber?: number;
}

export interface Chunk {
  text: string;
  index: number;
  tokenCount: number;
  blockKind: BlockKind;
  headingPath: string[];
  pageNumber?: number;
  startOffset: number;
  endOffset: number;
}

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
  minTokens: number;
  softMaxTokens?: number;
  semanticSplit?: boolean;
  semanticMaxDepth?: number;
}

export interface ChunkResult {
  chunks: Chunk[];
  blockIndexByChunk: number[][];
}

export const DEFAULT_CHUNK_OPTIONS: Required<Omit<ChunkOptions, 'semanticSplit' | 'semanticMaxDepth'>> & {
  semanticSplit: boolean;
  semanticMaxDepth: number;
} = {
  maxTokens: 512,
  overlapTokens: 64,
  minTokens: 32,
  softMaxTokens: 768,
  semanticSplit: false,
  semanticMaxDepth: 2,
};

export function readEnvOptions(overrides: Partial<ChunkOptions> = {}): ChunkOptions {
  const maxTokens = overrides.maxTokens
    ?? parseIntEnv('CHUNK_MAX_TOKENS', DEFAULT_CHUNK_OPTIONS.maxTokens);
  const overlapTokens = overrides.overlapTokens
    ?? parseIntEnv('CHUNK_OVERLAP_TOKENS', DEFAULT_CHUNK_OPTIONS.overlapTokens);
  const minTokens = overrides.minTokens
    ?? parseIntEnv('CHUNK_MIN_TOKENS', DEFAULT_CHUNK_OPTIONS.minTokens);
  const softMaxTokens = overrides.softMaxTokens
    ?? parseIntEnv('CHUNK_SOFT_MAX_TOKENS', Math.floor(maxTokens * 1.5));
  const semanticSplit = overrides.semanticSplit
    ?? readBoolEnv('CHUNK_SEMANTIC_SPLIT', DEFAULT_CHUNK_OPTIONS.semanticSplit);
  const semanticMaxDepth = overrides.semanticMaxDepth
    ?? parseIntEnv('CHUNK_SEMANTIC_MAX_DEPTH', DEFAULT_CHUNK_OPTIONS.semanticMaxDepth);
  return {
    maxTokens,
    overlapTokens,
    minTokens,
    softMaxTokens,
    semanticSplit,
    semanticMaxDepth,
  };
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export type { ParsedBlock };