import { countTokens, splitOnSentences } from './chunk-tokenizer.js';
import type { Chunk, ChunkOptions } from './chunk-types.js';

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface Window {
  text: string;
  startOffset: number;
  endOffset: number;
}

function buildWindows(text: string, windowSize: number, stepSize: number, baseOffset: number): Window[] {
  const sentences = splitOnSentences(text);
  if (sentences.length === 0) return [];

  const windows: Window[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let bufferStart = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i] ?? '';
    const tokens = countTokens(sentence);

    if (buffer.length === 0) bufferStart = i;
    buffer.push(sentence);
    bufferTokens += tokens;

    if (bufferTokens >= windowSize || i === sentences.length - 1) {
      const text2 = buffer.join(' ');
      const offset = sentences.slice(bufferStart, i + 1).join(' ').length;
      windows.push({
        text: text2,
        startOffset: baseOffset,
        endOffset: baseOffset + offset,
      });
      const sentencesToDrop = Math.max(1, Math.floor(stepSize / (bufferTokens / buffer.length)));
      buffer = sentences.slice(bufferStart + sentencesToDrop);
      bufferTokens = buffer.reduce((sum, s) => sum + countTokens(s), 0);
      bufferStart = bufferStart + sentencesToDrop;
    }
  }

  return windows;
}

export async function applySemanticSplit(
  chunk: Chunk,
  options: { softMaxTokens: number; maxDepth?: number; embedFn: EmbedFn }
): Promise<Chunk[]> {
  const { softMaxTokens, embedFn } = options;
  const maxDepth = options.maxDepth ?? 2;

  if (chunk.tokenCount <= softMaxTokens) return [chunk];

  return await splitAtLowestSimilarity(chunk, softMaxTokens, maxDepth, embedFn, 0);
}

async function splitAtLowestSimilarity(
  chunk: Chunk,
  softMaxTokens: number,
  maxDepth: number,
  embedFn: EmbedFn,
  depth: number
): Promise<Chunk[]> {
  if (depth >= maxDepth) return [chunk];
  if (chunk.tokenCount <= softMaxTokens) return [chunk];

  const windowSize = Math.max(64, Math.floor(chunk.tokenCount / 2));
  const stepSize = Math.max(16, Math.floor(windowSize / 2));
  const windows = buildWindows(chunk.text, windowSize, stepSize, chunk.startOffset);
  if (windows.length < 2) return [chunk];

  const embeddings = await embedFn(windows.map((w) => w.text));
  if (embeddings.length !== windows.length) return [chunk];

  let minSim = Infinity;
  let minIdx = -1;
  for (let i = 0; i < embeddings.length - 1; i++) {
    const sim = cosineSimilarity(embeddings[i] ?? [], embeddings[i + 1] ?? []);
    if (sim < minSim) {
      minSim = sim;
      minIdx = i;
    }
  }

  if (minIdx < 0) return [chunk];

  const splitWindow = windows[minIdx];
  const splitOffset = splitWindow ? splitWindow.endOffset - chunk.startOffset : Math.floor(chunk.text.length / 2);

  const leftText = chunk.text.slice(0, splitOffset).trim();
  const rightText = chunk.text.slice(splitOffset).trim();
  if (!leftText || !rightText) return [chunk];

  const leftChunk: Chunk = {
    ...chunk,
    text: leftText,
    tokenCount: countTokens(leftText),
    endOffset: chunk.startOffset + leftText.length,
  };
  const rightChunk: Chunk = {
    ...chunk,
    text: rightText,
    tokenCount: countTokens(rightText),
    startOffset: chunk.startOffset + leftText.length,
  };

  const [leftSplit, rightSplit] = await Promise.all([
    splitAtLowestSimilarity(leftChunk, softMaxTokens, maxDepth, embedFn, depth + 1),
    splitAtLowestSimilarity(rightChunk, softMaxTokens, maxDepth, embedFn, depth + 1),
  ]);

  return [...leftSplit, ...rightSplit];
}

export async function applySemanticSplitToChunks(
  chunks: Chunk[],
  options: ChunkOptions & { embedFn: EmbedFn }
): Promise<Chunk[]> {
  if (!options.semanticSplit) return chunks;
  const softMaxTokens = options.softMaxTokens ?? Math.floor(options.maxTokens * 1.5);
  const maxDepth = options.semanticMaxDepth ?? 2;

  const results: Chunk[] = [];
  for (const chunk of chunks) {
    const split = await applySemanticSplit(chunk, {
      softMaxTokens,
      maxDepth,
      embedFn: options.embedFn,
    });
    results.push(...split);
  }

  results.forEach((c, i) => {
    c.index = i;
  });
  return results;
}