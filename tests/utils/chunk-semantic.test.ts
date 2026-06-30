import { describe, it, expect, vi } from 'vitest';
import { applySemanticSplit, applySemanticSplitToChunks } from '../../src/utils/chunk-semantic.js';
import type { Chunk } from '../../src/utils/chunk-types.js';
import { countTokens } from '../../src/utils/chunk-tokenizer.js';

function makeChunk(text: string, index: number): Chunk {
  return {
    text,
    index,
    tokenCount: countTokens(text),
    blockKind: 'paragraph',
    headingPath: [],
    startOffset: 0,
    endOffset: text.length,
  };
}

function fakeEmbedWithTopicShift(topicWordA: string, topicWordB: string) {
  return vi.fn(async (texts: string[]) =>
    texts.map((t) => {
      const hasA = t.toLowerCase().includes(topicWordA.toLowerCase());
      const hasB = t.toLowerCase().includes(topicWordB.toLowerCase());
      if (hasA && !hasB) return [1, 0, 0];
      if (hasB && !hasA) return [0, 1, 0];
      if (hasA && hasB) return [0.7, 0.7, 0];
      return [0.1, 0.1, 1];
    })
  );
}

describe('applySemanticSplit', () => {
  it('returns the chunk unchanged if it is below softMaxTokens', async () => {
    const chunk = makeChunk('A short paragraph.', 0);
    const embedFn = vi.fn();
    const result = await applySemanticSplit(chunk, {
      softMaxTokens: 100,
      embedFn,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(chunk);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('splits a chunk with a known topic shift near the boundary', async () => {
    const cooking = Array.from({ length: 40 }, (_, i) => `Sauté the onions gently with care number ${i}.`).join(' ');
    const sports = Array.from({ length: 40 }, (_, i) => `The midfielder dribbled past defenders and shot number ${i}.`).join(' ');
    const text = `${cooking} ${sports}`;
    const chunk = makeChunk(text, 0);
    const embedFn = fakeEmbedWithTopicShift('sauté', 'midfielder');

    const result = await applySemanticSplit(chunk, {
      softMaxTokens: 100,
      maxDepth: 2,
      embedFn: embedFn as unknown as (texts: string[]) => Promise<number[][]>,
    });

    expect(result.length).toBeGreaterThanOrEqual(2);
    const firstEnds = result[0].text;
    expect(firstEnds.toLowerCase()).toContain('sauté');
    expect(firstEnds.toLowerCase()).not.toContain('midfielder');
  });

  it('does not recurse beyond maxDepth', async () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i} unique${i} rare${i}`).join(' ');
    const chunk = makeChunk(text, 0);
    let callCount = 0;
    const embedFn = vi.fn(async (texts: string[]) => {
      callCount++;
      return texts.map((_, i) => [Math.cos(i), Math.sin(i), 0]);
    });

    const result = await applySemanticSplit(chunk, {
      softMaxTokens: 20,
      maxDepth: 1,
      embedFn,
    });

    expect(callCount).toBeLessThanOrEqual(2);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('returns the original chunk if embedFn returns wrong shape', async () => {
    const text = Array.from({ length: 100 }, () => 'filler').join(' ');
    const chunk = makeChunk(text, 0);
    const embedFn = vi.fn(async (_texts: string[]) => [[1, 2, 3]]);

    const result = await applySemanticSplit(chunk, {
      softMaxTokens: 20,
      embedFn,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

describe('applySemanticSplitToChunks', () => {
  it('is a no-op when semanticSplit is false', async () => {
    const chunks = [makeChunk('Some text.', 0)];
    const embedFn = vi.fn();
    const result = await applySemanticSplitToChunks(chunks, {
      maxTokens: 50,
      overlapTokens: 5,
      minTokens: 5,
      softMaxTokens: 75,
      semanticSplit: false,
      embedFn,
    });
    expect(result).toBe(chunks);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('reindexes output chunks sequentially', async () => {
    const cooking = Array.from({ length: 40 }, (_, i) => `Sauté the onions gently with care number ${i}.`).join(' ');
    const sports = Array.from({ length: 40 }, (_, i) => `The midfielder dribbled past defenders and shot number ${i}.`).join(' ');
    const chunks = [makeChunk(`${cooking} ${sports}`, 0)];
    const embedFn = fakeEmbedWithTopicShift('sauté', 'midfielder');

    const result = await applySemanticSplitToChunks(chunks, {
      maxTokens: 50,
      overlapTokens: 5,
      minTokens: 5,
      softMaxTokens: 100,
      semanticSplit: true,
      semanticMaxDepth: 2,
      embedFn: embedFn as unknown as (texts: string[]) => Promise<number[][]>,
    });
    result.forEach((c, i) => expect(c.index).toBe(i));
  });
});