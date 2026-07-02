import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.QDRANT_URL = 'http://qdrant:6333';
  process.env.QDRANT_COLLECTION = 'documents_test';
  process.env.VECTOR_SIZE = '768';
});

const {
  mockGetCollections,
  mockCreateCollection,
  mockCreatePayloadIndex,
  mockUpsert,
  mockQuery,
  mockDelete,
} = vi.hoisted(() => ({
  mockGetCollections: vi.fn(),
  mockCreateCollection: vi.fn(),
  mockCreatePayloadIndex: vi.fn(),
  mockUpsert: vi.fn(),
  mockQuery: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('@qdrant/qdrant-js', () => ({
  QdrantClient: class {
    getCollections = mockGetCollections;
    createCollection = mockCreateCollection;
    createPayloadIndex = mockCreatePayloadIndex;
    upsert = mockUpsert;
    query = mockQuery;
    delete = mockDelete;
  },
}));

import { initCollection, searchChunks, expandHits, upsertChunks, deleteByFilePath } from '../../src/services/qdrant.js';

describe('initCollection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates collection if it does not exist', async () => {
    mockGetCollections.mockResolvedValueOnce({ collections: [] });
    mockCreateCollection.mockResolvedValueOnce({});
    mockCreatePayloadIndex.mockResolvedValue({});

    await initCollection();

    expect(mockCreateCollection).toHaveBeenCalledWith(
      'documents_test',
      expect.objectContaining({
        vectors: expect.objectContaining({ size: 768, distance: 'Cosine' }),
      })
    );
  });

  it('skips creation when collection exists', async () => {
    mockGetCollections.mockResolvedValueOnce({
      collections: [{ name: 'documents_test' }],
    });
    mockCreatePayloadIndex.mockResolvedValue({});

    await initCollection();

    expect(mockCreateCollection).not.toHaveBeenCalled();
  });

  it('creates payload indexes on fileName, filePath, fileType, pageNumber', async () => {
    mockGetCollections.mockResolvedValueOnce({
      collections: [{ name: 'documents_test' }],
    });
    mockCreatePayloadIndex.mockResolvedValue({});

    await initCollection();

    const calls = mockCreatePayloadIndex.mock.calls;
    const fields = calls.map((c) => c[1].field_name);
    expect(fields).toContain('fileName');
    expect(fields).toContain('filePath');
    expect(fields).toContain('fileType');
    expect(fields).toContain('pageNumber');
  });

  it('tolerates "index already exists" errors', async () => {
    mockGetCollections.mockResolvedValueOnce({
      collections: [{ name: 'documents_test' }],
    });
    mockCreatePayloadIndex.mockRejectedValue(new Error('Index already exists'));

    await expect(initCollection()).resolves.not.toThrow();
  });
});

describe('searchChunks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns mapped DocumentChunk array', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        id: 'abc',
        vector: [0.1, 0.2, 0.3],
        payload: {
          chunk: 'hello',
          fileName: 'doc.md',
          fileType: '.md',
          filePath: 'abc.md',
          chunkIndex: 0,
          totalChunks: 3,
        },
        score: 0.9,
      },
    ]);

    const results = await searchChunks([0.1, 0.2], { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('abc');
    expect(results[0].payload.chunk).toBe('hello');
    expect(results[0].score).toBe(0.9);
  });

  it('builds a filter when fileName/fileType are provided', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await searchChunks([0.1], { fileName: 'doc.pdf', fileType: '.pdf' });
    const call = mockQuery.mock.calls[0];
    const filter = call[1].filter;
    expect(filter).toBeDefined();
    expect(JSON.stringify(filter)).toContain('doc.pdf');
    expect(JSON.stringify(filter)).toContain('.pdf');
  });

  it('passes limit through to Qdrant', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await searchChunks([0.1], { limit: 7 });
    const call = mockQuery.mock.calls[0];
    expect(call[1].limit).toBe(7);
  });
});

describe('expandHits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the original hits when mode is none', async () => {
    const hits = [
      {
        id: '1',
        vector: [],
        payload: { chunk: 'a', fileName: 'x', fileType: '.md', filePath: 'x.md', chunkIndex: 0, totalChunks: 3 },
        score: 0.9,
      },
    ];
    const result = await expandHits(hits, { mode: 'none' });
    expect(result).toBe(hits);
  });

  it('fetches siblings in siblings mode', async () => {
    mockQuery
      .mockResolvedValueOnce([
        {
          id: '2',
          vector: [],
          payload: { chunk: 'b', fileName: 'x', fileType: '.md', filePath: 'x.md', chunkIndex: 1, totalChunks: 3 },
        },
      ])
      .mockResolvedValueOnce([]);

    const hits = [
      {
        id: '1',
        vector: [],
        payload: { chunk: 'a', fileName: 'x', fileType: '.md', filePath: 'x.md', chunkIndex: 0, totalChunks: 3 },
        score: 0.9,
      },
    ];
    const result = await expandHits(hits, { mode: 'siblings', siblingsRange: 2 });
    expect(result.length).toBeGreaterThan(1);
    expect(result.map((r) => r.id)).toContain('2');
  });

  it('skips section expansion when headingPath is empty', async () => {
    const hits = [
      {
        id: '1',
        vector: [],
        payload: { chunk: 'a', fileName: 'x', fileType: '.md', filePath: 'x.md', chunkIndex: 0, totalChunks: 3 },
        score: 0.9,
      },
    ];
    const result = await expandHits(hits, { mode: 'sections' });
    expect(result).toEqual(hits);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('upsertChunks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op for empty input', async () => {
    await upsertChunks([]);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('upserts points with vector and payload', async () => {
    mockUpsert.mockResolvedValueOnce({});
    await upsertChunks([
      {
        id: 'p1',
        vector: [0.1, 0.2],
        payload: { chunk: 'a', fileName: 'x', fileType: '.md', filePath: 'x.md', chunkIndex: 0, totalChunks: 1 },
      },
    ]);
    const call = mockUpsert.mock.calls[0];
    expect(call[1].points).toHaveLength(1);
    expect(call[1].points[0].id).toBe('p1');
    expect(call[1].points[0].vector).toEqual([0.1, 0.2]);
  });
});

// Phase 03 / p3-T02 — deleteByFilePath.
describe('deleteByFilePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls client.delete with a filePath filter and returns the count', async () => {
    // The Qdrant SDK's delete returns { result: { deleted, deleted_count? } }
    // for a sync delete; we read whichever field is present.
    mockDelete.mockResolvedValueOnce({ result: { deleted: 7 } });

    const n = await deleteByFilePath('abc-123.md');
    expect(n).toBe(7);

    const call = mockDelete.mock.calls[0];
    expect(call[0]).toBe('documents_test');
    const filter = call[1].filter;
    expect(JSON.stringify(filter)).toContain('filePath');
    expect(JSON.stringify(filter)).toContain('abc-123.md');
  });

  it('returns 0 when no points match (idempotent)', async () => {
    mockDelete.mockResolvedValueOnce({ result: { deleted: 0 } });
    expect(await deleteByFilePath('nothing-here.md')).toBe(0);
  });

  it('falls back to 0 when the response shape omits the deleted count', async () => {
    mockDelete.mockResolvedValueOnce({ status: 'acknowledged' });
    expect(await deleteByFilePath('orphaned.md')).toBe(0);
  });

  it('propagates errors from the SDK', async () => {
    mockDelete.mockRejectedValueOnce(new Error('qdrant down'));
    await expect(deleteByFilePath('x.md')).rejects.toThrow('qdrant down');
  });
});