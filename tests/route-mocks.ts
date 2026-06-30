// Shared mocks for route tests. Mocks the embed/qdrant/openai wrappers used by routes.

import { vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockEmbedText: vi.fn(),
  mockEmbedTexts: vi.fn(),
  mockSearchChunks: vi.fn(),
  mockUpsertChunks: vi.fn(),
  mockInitCollection: vi.fn(),
  mockExpandHits: vi.fn(),
  mockCreateChatCompletion: vi.fn(),
  mockChatWithDocuments: vi.fn(),
  mockOpenAIInstance: {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  },
  capturedFilter: { current: undefined as Record<string, unknown> | undefined },
  capturedQueryText: { current: '' as string },
  capturedUploadChunks: { current: [] as unknown[] },
  capturedVector: { current: undefined as number[] | undefined },
  capturedCreatePayloadIndexCalls: { current: [] as Array<{ field: string; schema: string }> },
  capturedLastCreateChatArgs: { current: undefined as unknown },
}));

vi.mock('../../src/services/embed.js', () => ({
  embedText: mocks.mockEmbedText,
  embedTexts: mocks.mockEmbedTexts,
}));

vi.mock('../../src/services/qdrant.js', () => ({
  initCollection: mocks.mockInitCollection,
  upsertChunks: mocks.mockUpsertChunks,
  searchChunks: mocks.mockSearchChunks,
  expandHits: mocks.mockExpandHits,
}));

vi.mock('../../src/services/openai-api-wrapper.js', () => ({
  createChatCompletion: mocks.mockCreateChatCompletion,
  chatWithDocuments: mocks.mockChatWithDocuments,
}));

vi.mock('openai', () => ({
  default: function () {
    return mocks.mockOpenAIInstance;
  },
}));

export default mocks;

export function resetMocks(): void {
  mocks.mockEmbedText.mockReset();
  mocks.mockEmbedTexts.mockReset();
  mocks.mockSearchChunks.mockReset();
  mocks.mockUpsertChunks.mockReset();
  mocks.mockInitCollection.mockReset();
  mocks.mockExpandHits.mockReset();
  mocks.mockCreateChatCompletion.mockReset();
  mocks.mockChatWithDocuments.mockReset();
  mocks.capturedFilter.current = undefined;
  mocks.capturedQueryText.current = '';
  mocks.capturedUploadChunks.current = [];
  mocks.capturedVector.current = undefined;
  mocks.capturedCreatePayloadIndexCalls.current = [];
  mocks.capturedLastCreateChatArgs.current = undefined;
  mocks.mockOpenAIInstance.chat.completions.create.mockReset();
}

export const mockState = mocks;