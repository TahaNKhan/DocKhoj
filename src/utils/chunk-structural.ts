import type { ParsedBlock } from '../parser/parser-types.js';
import { countTokens, splitOnSentences, takeFirstSentences, takeLastSentences } from './chunk-tokenizer.js';
import type { Chunk, ChunkOptions } from './chunk-types.js';

interface ChunkAccumulator {
  texts: string[];
  tokenCount: number;
  startOffset: number;
  endOffset: number;
  primaryKind: ParsedBlock['kind'];
  headingPath: string[];
  pageNumber?: number;
  blockIndices: number[];
}

function isOversizedBlock(block: ParsedBlock, maxTokens: number): boolean {
  return countTokens(block.text) > maxTokens;
}

function splitLargeTextByTokens(
  text: string,
  maxTokens: number,
  startOffset: number
): { text: string; startOffset: number; endOffset: number }[] {
  const sentences = splitOnSentences(text);
  const result: { text: string; startOffset: number; endOffset: number }[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let bufferStart = startOffset;
  let cursor = startOffset;

  const flush = () => {
    if (!buffer.length) return;
    const segmentText = buffer.join(' ');
    result.push({
      text: segmentText,
      startOffset: bufferStart,
      endOffset: bufferStart + segmentText.length,
    });
    buffer = [];
    bufferTokens = 0;
  };

  for (const sentence of sentences) {
    const tokens = countTokens(sentence);
    if (tokens > maxTokens) {
      flush();
      result.push({
        text: sentence,
        startOffset: cursor,
        endOffset: cursor + sentence.length,
      });
    } else if (bufferTokens + tokens > maxTokens) {
      flush();
      bufferStart = cursor;
      buffer.push(sentence);
      bufferTokens = tokens;
    } else {
      if (!buffer.length) bufferStart = cursor;
      buffer.push(sentence);
      bufferTokens += tokens;
    }
    cursor += sentence.length + 1;
  }
  flush();
  return result;
}

function oversizedSubChunks(
  block: ParsedBlock,
  maxTokens: number
): ParsedBlock[] {
  const parts = splitLargeTextByTokens(block.text, maxTokens, block.startOffset);
  return parts.map((p) => ({
    ...block,
    text: p.text,
    startOffset: p.startOffset,
    endOffset: p.endOffset,
  }));
}

function splitListItems(block: ParsedBlock, maxTokens: number): ParsedBlock[] {
  const lines = block.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const result: ParsedBlock[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let bufferStart = block.startOffset;
  let cursor = block.startOffset;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join('\n');
    result.push({
      ...block,
      text,
      startOffset: bufferStart,
      endOffset: bufferStart + text.length,
    });
    buffer = [];
    bufferTokens = 0;
  };

  for (const line of lines) {
    const tokens = countTokens(line);
    if (tokens > maxTokens) {
      flush();
      const segments = splitLargeTextByTokens(line, maxTokens, cursor);
      for (const s of segments) {
        result.push({
          ...block,
          text: s.text,
          startOffset: s.startOffset,
          endOffset: s.endOffset,
        });
      }
      cursor += line.length + 1;
      bufferStart = cursor;
      continue;
    }
    if (bufferTokens + tokens > maxTokens && buffer.length > 0) {
      flush();
      bufferStart = cursor;
    }
    if (!buffer.length) bufferStart = cursor;
    buffer.push(line);
    bufferTokens += tokens;
    cursor += line.length + 1;
  }
  flush();
  return result;
}

function flushAccumulator(
  acc: ChunkAccumulator,
  output: Chunk[],
  index: { i: number }
): void {
  if (!acc.texts.length) return;
  const text = acc.texts.join('\n\n').trim();
  if (!text) return;
  output.push({
    text,
    index: index.i++,
    tokenCount: acc.tokenCount,
    blockKind: acc.primaryKind,
    headingPath: [...acc.headingPath],
    pageNumber: acc.pageNumber,
    startOffset: acc.startOffset,
    endOffset: acc.endOffset,
  });
}

function makeAccumulator(): ChunkAccumulator {
  return {
    texts: [],
    tokenCount: 0,
    startOffset: 0,
    endOffset: 0,
    primaryKind: 'other',
    headingPath: [],
    blockIndices: [],
  };
}

function ingestBlock(
  acc: ChunkAccumulator,
  block: ParsedBlock,
  blockIndex: number
): void {
  if (!acc.texts.length) {
    acc.startOffset = block.startOffset;
    acc.primaryKind = block.kind;
    acc.headingPath = [...block.headingPath];
    acc.pageNumber = block.pageNumber;
  }
  acc.texts.push(block.text);
  acc.tokenCount += countTokens(block.text);
  acc.endOffset = block.endOffset;
  acc.blockIndices.push(blockIndex);
}

function seedAccumulatorFromText(
  acc: ChunkAccumulator,
  text: string,
  template: ParsedBlock
): void {
  acc.texts = [text];
  acc.tokenCount = countTokens(text);
  acc.startOffset = template.startOffset;
  acc.endOffset = template.startOffset + text.length;
  acc.primaryKind = template.kind;
  acc.headingPath = [...template.headingPath];
  acc.pageNumber = template.pageNumber;
}

function buildOverlapSeed(
  acc: ChunkAccumulator,
  overlapTokens: number,
  template: ParsedBlock
): { text: string; primaryKind: ParsedBlock['kind'] } {
  if (acc.tokenCount <= overlapTokens) {
    return { text: acc.texts.join('\n\n'), primaryKind: acc.primaryKind };
  }
  const text = acc.texts.join('\n\n');
  const tail = takeLastSentences(text, overlapTokens);
  return { text: tail, primaryKind: acc.primaryKind };
}

export function chunkBlocksStructural(
  blocks: ParsedBlock[],
  options: ChunkOptions
): Chunk[] {
  if (!blocks.length) return [];

  const { maxTokens, overlapTokens, minTokens } = options;

  const expanded: { block: ParsedBlock; originalIndex: number }[] = [];
  blocks.forEach((block, originalIndex) => {
    if (isOversizedBlock(block, maxTokens)) {
      if (block.kind === 'list') {
        for (const sub of splitListItems(block, maxTokens)) {
          expanded.push({ block: sub, originalIndex });
        }
      } else if (block.kind === 'code') {
        for (const sub of oversizedSubChunks(block, maxTokens)) {
          expanded.push({ block: sub, originalIndex });
        }
      } else {
        for (const sub of oversizedSubChunks(block, maxTokens)) {
          expanded.push({ block: sub, originalIndex });
        }
      }
    } else {
      expanded.push({ block, originalIndex });
    }
  });

  const output: Chunk[] = [];
  const indexRef = { i: 0 };
  let acc = makeAccumulator();

  for (const { block } of expanded) {
    if (block.kind === 'heading') {
      flushAccumulator(acc, output, indexRef);
      acc = makeAccumulator();
      const headingChunk: Chunk = {
        text: block.text,
        index: indexRef.i++,
        tokenCount: countTokens(block.text),
        blockKind: 'heading',
        headingPath: [...block.headingPath],
        pageNumber: block.pageNumber,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
      };
      output.push(headingChunk);
      continue;
    }

    const blockTokens = countTokens(block.text);
    const wouldOverflow = acc.tokenCount + blockTokens > maxTokens && acc.texts.length > 0;

    if (wouldOverflow) {
      const overlap = buildOverlapSeed(acc, overlapTokens, block);
      flushAccumulator(acc, output, indexRef);
      acc = makeAccumulator();
      if (overlap.text && overlap.text.trim().length > 0) {
        seedAccumulatorFromText(acc, overlap.text, {
          ...block,
          text: overlap.text,
          kind: overlap.primaryKind,
        });
      }
    }

    ingestBlock(acc, block, -1);
  }

  flushAccumulator(acc, output, indexRef);

  if (
    output.length > 1 &&
    output[output.length - 1].tokenCount < minTokens &&
    output[output.length - 1].blockKind !== 'heading' &&
    output[output.length - 2].blockKind !== 'heading'
  ) {
    const last = output.pop();
    const prev = output[output.length - 1];
    if (last && prev) {
      const mergedText = `${prev.text}\n\n${last.text}`;
      prev.text = mergedText;
      prev.tokenCount = countTokens(mergedText);
      prev.endOffset = last.endOffset;
    }
  }

  output.forEach((chunk, i) => {
    chunk.index = i;
  });

  return output;
}

void takeFirstSentences;