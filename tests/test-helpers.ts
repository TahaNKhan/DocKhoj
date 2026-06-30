// Shared test helpers: in-memory Qdrant + Ollama mocks.

import type { DocumentChunk } from '../src/services/qdrant.js';

export interface MockQdrantState {
  upsertedChunks: DocumentChunk[];
  storedHits: DocumentChunk[];
  filterUsed: Record<string, unknown> | undefined;
}

export function createMockQdrant() {
  const state: MockQdrantState = {
    upsertedChunks: [],
    storedHits: [],
    filterUsed: undefined,
  };

  return {
    state,
    async upsertChunks(chunks: DocumentChunk[]) {
      for (const chunk of chunks) {
        const idx = state.upsertedChunks.findIndex((c) => c.id === chunk.id);
        if (idx >= 0) state.upsertedChunks[idx] = chunk;
        else state.upsertedChunks.push(chunk);
      }
    },
    async searchChunks(_vector: number[], opts: { limit?: number; fileName?: string; fileType?: string }) {
      const results = state.upsertedChunks.filter((c) => {
        if (opts.fileName && c.payload.fileName !== opts.fileName) return false;
        if (opts.fileType && c.payload.fileType !== opts.fileType) return false;
        return true;
      });
      const sliced = results.slice(0, opts.limit ?? 5).map((c) => ({ ...c, score: 0.9 }));
      state.storedHits = sliced as DocumentChunk[];
      return sliced as DocumentChunk[];
    },
    async expandHits(hits: DocumentChunk[], _opts: { mode: string }) {
      return hits;
    },
  };
}

export function createMockEmbedder() {
  return {
    async embedText(text: string): Promise<number[]> {
      const out = new Array(8).fill(0);
      for (let i = 0; i < text.length; i++) {
        out[i % 8] = (out[i % 8] + text.charCodeAt(i)) / 256;
      }
      return out;
    },
    async embedTexts(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => this.embedText(t)));
    },
  };
}