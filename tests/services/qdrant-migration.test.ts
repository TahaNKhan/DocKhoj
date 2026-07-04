import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.QDRANT_URL = 'http://qdrant:6333';
  process.env.QDRANT_COLLECTION = 'documents_test';
  process.env.QDRANT_METADATA_COLLECTION = 'app_metadata_test';
  process.env.VECTOR_SIZE = '768';
});

const {
  mockGetCollections,
  mockCreateCollection,
  mockCreatePayloadIndex,
  mockRetrieve,
  mockUpsert,
  mockScroll,
  mockSetPayload,
} = vi.hoisted(() => ({
  mockGetCollections: vi.fn(),
  mockCreateCollection: vi.fn(),
  mockCreatePayloadIndex: vi.fn(),
  mockRetrieve: vi.fn(),
  mockUpsert: vi.fn(),
  mockScroll: vi.fn(),
  mockSetPayload: vi.fn(),
}));

vi.mock('@qdrant/qdrant-js', () => ({
  QdrantClient: class {
    getCollections = mockGetCollections;
    createCollection = mockCreateCollection;
    createPayloadIndex = mockCreatePayloadIndex;
    retrieve = mockRetrieve;
    upsert = mockUpsert;
    scroll = mockScroll;
    setPayload = mockSetPayload;
  },
}));

import {
  initCollection,
  setOwnerVisibility,
  migratePayloads,
  getMetadata,
  setMetadata,
} from '../../src/services/qdrant.js';

const DOCUMENTS_COLLECTION = 'documents_test';
const METADATA_COLLECTION = 'app_metadata_test';

describe('Phase 04 / p4-T03 — payload indexes', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): clears call history AND
    // queued mockReturnValueOnce chains. The shared hoisted mocks
    // would otherwise leak stale queued values between tests.
    vi.resetAllMocks();
  });

  it('ensurePayloadIndexes creates keyword indexes for ownerId and visibility', async () => {
    mockGetCollections.mockResolvedValueOnce({
      collections: [{ name: DOCUMENTS_COLLECTION }],
    });
    mockCreatePayloadIndex.mockResolvedValue({});

    await initCollection();

    const fields = mockCreatePayloadIndex.mock.calls.map((c) => c[1].field_name);
    expect(fields).toContain('ownerId');
    expect(fields).toContain('visibility');
    // Pre-Phase-04 indexes still present.
    expect(fields).toContain('fileName');
    expect(fields).toContain('filePath');
  });

  it('ensurePayloadIndexes tolerates "index already exists" on ownerId/visibility', async () => {
    mockGetCollections.mockResolvedValueOnce({
      collections: [{ name: DOCUMENTS_COLLECTION }],
    });
    mockCreatePayloadIndex.mockRejectedValue(new Error('Index already exists'));

    await expect(initCollection()).resolves.not.toThrow();
  });
});

describe('setOwnerVisibility', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): clears call history AND
    // queued mockReturnValueOnce chains. The shared hoisted mocks
    // would otherwise leak stale queued values between tests.
    vi.resetAllMocks();
  });

  it('calls setPayload with a filePath filter and the owner/visibility payload', async () => {
    mockSetPayload.mockResolvedValueOnce({ result: { operation_id: 1 } });

    await setOwnerVisibility('abc-123.md', 'user-1', 'private');

    expect(mockSetPayload).toHaveBeenCalledTimes(1);
    const [collection, args] = mockSetPayload.mock.calls[0];
    expect(collection).toBe(DOCUMENTS_COLLECTION);
    expect(args.payload).toEqual({ ownerId: 'user-1', visibility: 'private' });
    expect(args.filter.must[0]).toEqual({
      key: 'filePath',
      match: { value: 'abc-123.md' },
    });
  });

  it('accepts null ownerId for shared files (translated to NO_OWNER_SENTINEL)', async () => {
    mockSetPayload.mockResolvedValueOnce({});

    await setOwnerVisibility('legacy.md', null, 'public');

    const args = mockSetPayload.mock.calls[0][1];
    // null → '' because Qdrant 1.17's setPayload treats null as
    // "delete the key" (verified empirically). The filter clause
    // `match: { value: viewerId }` won't match '' for any real
    // viewerId, so semantics are preserved.
    expect(args.payload).toEqual({ ownerId: '', visibility: 'public' });
  });
});

describe('app_metadata helpers', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): clears call history AND
    // queued mockReturnValueOnce chains. The shared hoisted mocks
    // would otherwise leak stale queued values between tests.
    vi.resetAllMocks();
  });

  it('getMetadata returns the stored value', async () => {
    mockRetrieve.mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000001',
        payload: {
          key: 'phase_04_qdrant_migration_applied',
          value: '2026-07-03T00:00:00Z',
        },
      },
    ]);
    expect(
      await getMetadata('phase_04_qdrant_migration_applied')
    ).toBe('2026-07-03T00:00:00Z');
  });

  it('getMetadata returns null when the key is absent', async () => {
    mockRetrieve.mockResolvedValueOnce([]);
    expect(await getMetadata('phase_04_qdrant_migration_applied')).toBeNull();
  });

  it('getMetadata returns null when the SDK throws', async () => {
    mockRetrieve.mockRejectedValueOnce(new Error('qdrant down'));
    expect(await getMetadata('phase_04_qdrant_migration_applied')).toBeNull();
  });

  it('setMetadata upserts into the metadata collection', async () => {
    mockUpsert.mockResolvedValueOnce({});
    await setMetadata('phase_04_qdrant_migration_applied', '2026-07-03T00:00:00Z');

    const [collection, args] = mockUpsert.mock.calls[0];
    expect(collection).toBe(METADATA_COLLECTION);
    expect(args.points).toHaveLength(1);
    // Point ID must be a UUID (Qdrant rejects arbitrary strings).
    expect(typeof args.points[0].id).toBe('string');
    expect(args.points[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(args.points[0].payload).toEqual({
      key: 'phase_04_qdrant_migration_applied',
      value: '2026-07-03T00:00:00Z',
    });
    expect(args.points[0].vector).toEqual([0]);
  });
});

describe('migratePayloads', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): clears call history AND
    // queued mockReturnValueOnce chains. The shared hoisted mocks
    // would otherwise leak stale queued values between tests.
    vi.resetAllMocks();
  });

  it('is a no-op when the migration flag is already set', async () => {
    // ensureMetadataCollection: present.
    mockGetCollections.mockResolvedValueOnce({
      collections: [{ name: DOCUMENTS_COLLECTION }, { name: METADATA_COLLECTION }],
    });
    mockRetrieve.mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000001',
        payload: {
          key: 'phase_04_qdrant_migration_applied',
          value: '2026-01-01T00:00:00Z',
        },
      },
    ]);

    const result = await migratePayloads();
    expect(result).toEqual({ scanned: 0, updated: 0, alreadyMigrated: true });
    expect(mockScroll).not.toHaveBeenCalled();
    expect(mockSetPayload).not.toHaveBeenCalled();
  });

  it('scans legacy points missing ownerId/visibility and stamps them', async () => {
    // initCollection path: documents collection exists, metadata collection does not.
    mockGetCollections
      .mockResolvedValueOnce({
        collections: [{ name: DOCUMENTS_COLLECTION }],
      })
      // ensureMetadataCollection inside migratePayloads: not present.
      .mockResolvedValueOnce({
        collections: [{ name: DOCUMENTS_COLLECTION }],
      });
    mockCreateCollection.mockResolvedValue({}); // metadata collection created
    mockCreatePayloadIndex.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});
    // First getMetadata call (flag check): absent.
    // Second getMetadata call: not reached on this path.
    mockRetrieve.mockResolvedValueOnce([]);
    // scroll returns three points: two legacy (missing fields) + one already-good.
    mockScroll.mockResolvedValueOnce({
      points: [
        { id: 'p1', payload: { chunk: 'a', fileName: 'a.md', filePath: 'a.md' } },
        { id: 'p2', payload: { chunk: 'b', fileName: 'b.md', filePath: 'b.md' } },
        {
          id: 'p3',
          payload: {
            chunk: 'c',
            fileName: 'c.md',
            filePath: 'c.md',
            ownerId: 'u1',
            visibility: 'public',
          },
        },
      ],
      next_page_offset: null,
    });
    mockSetPayload.mockResolvedValueOnce({});
    mockUpsert.mockResolvedValueOnce({}); // setMetadata for the flag

    await initCollection();
    const result = await migratePayloads();

    expect(result.scanned).toBe(3);
    expect(result.updated).toBe(2);
    expect(result.alreadyMigrated).toBe(false);

    // Only the two legacy points were updated.
    expect(mockSetPayload).toHaveBeenCalledTimes(1);
    const [collection, args] = mockSetPayload.mock.calls[0];
    expect(collection).toBe(DOCUMENTS_COLLECTION);
    // Qdrant 1.17 deletes the key on null — see NO_OWNER_SENTINEL.
    expect(args.payload).toEqual({ ownerId: '', visibility: 'public' });
    expect(new Set(args.points)).toEqual(new Set(['p1', 'p2']));

    // The flag was set after migration.
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const flagUpsert = mockUpsert.mock.calls[0];
    expect(flagUpsert[0]).toBe(METADATA_COLLECTION);
    expect(typeof flagUpsert[1].points[0].id).toBe('string');
    expect(flagUpsert[1].points[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(flagUpsert[1].points[0].payload.key).toBe('phase_04_qdrant_migration_applied');
    expect(typeof flagUpsert[1].points[0].payload.value).toBe('string');
  });

  it('is idempotent: re-running with all points already stamped sets nothing', async () => {
    // initCollection: documents collection exists.
    mockGetCollections
      .mockResolvedValueOnce({
        collections: [{ name: DOCUMENTS_COLLECTION }],
      })
      // ensureMetadataCollection: not present.
      .mockResolvedValueOnce({
        collections: [{ name: DOCUMENTS_COLLECTION }],
      });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});
    mockRetrieve.mockResolvedValueOnce([]); // no flag yet
    mockScroll.mockResolvedValueOnce({
      points: [
        {
          id: 'p1',
          payload: {
            chunk: 'a',
            fileName: 'a.md',
            filePath: 'a.md',
            ownerId: null,
            visibility: 'public',
          },
        },
      ],
      next_page_offset: null,
    });
    mockSetPayload.mockResolvedValue({});
    mockUpsert.mockResolvedValueOnce({}); // setMetadata

    await initCollection();
    const result = await migratePayloads();

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(0);
    // We didn't need to call setPayload (no points lacked fields).
    expect(mockSetPayload).not.toHaveBeenCalled();
  });

  it('paginates: handles next_page_offset on a second scroll', async () => {
    mockGetCollections
      .mockResolvedValueOnce({
        collections: [{ name: DOCUMENTS_COLLECTION }],
      })
      .mockResolvedValueOnce({
        collections: [{ name: DOCUMENTS_COLLECTION }],
      });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});
    mockRetrieve.mockResolvedValueOnce([]);
    mockScroll
      .mockResolvedValueOnce({
        points: [
          { id: 'p1', payload: { chunk: 'a', fileName: 'a.md', filePath: 'a.md' } },
        ],
        next_page_offset: 999,
      })
      .mockResolvedValueOnce({
        points: [
          { id: 'p2', payload: { chunk: 'b', fileName: 'b.md', filePath: 'b.md' } },
        ],
        next_page_offset: null,
      });
    mockSetPayload.mockResolvedValue({});
    mockUpsert.mockResolvedValueOnce({});

    await initCollection();
    const result = await migratePayloads();

    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(2);
    expect(mockScroll).toHaveBeenCalledTimes(2);
    // Second scroll should pass the offset from the first page.
    expect(mockScroll.mock.calls[1][1].offset).toBe(999);
  });
});