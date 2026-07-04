import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.QDRANT_URL = 'http://qdrant:6333';
  process.env.QDRANT_COLLECTION = 'documents_visibility_test';
  process.env.VECTOR_SIZE = '768';
});

// Phase 04 / p4-T08 / FR-32 — verify the buildVisibilityFilter
// clause is threaded into every read-path Qdrant call and that
// user A never sees user B's private chunks.
//
// The pattern follows tests/services/qdrant.test.ts: mock the
// @qdrant/qdrant-js client and let the mock apply the filter to a
// canned chunk list. The mock is a tiny in-memory Qdrant — it
// evaluates the must/should clauses the same way real Qdrant does,
// so the assertion is end-to-end (filter shape + behavior), not
// just "did the code call setPayload with X".

interface MockChunk {
  id: string;
  ownerId: string;
  visibility: 'public' | 'private';
  chunk: string;
  fileName: string;
  filePath: string;
  chunkIndex: number;
  totalChunks: number;
}

const USER_A = 'user-alice';
const USER_B = 'user-bob';
const USER_C = 'user-carol';

// `chunks` is shared between the hoisted mock and the test bodies
// so tests can mutate payloads in place (e.g. flip visibility).
const chunks: MockChunk[] = [];

function seedChunks(): void {
  chunks.length = 0;
  chunks.push({
    id: 'a-priv-0',
    ownerId: USER_A,
    visibility: 'private',
    chunk: 'a-private-unique-marker alpha private',
    fileName: 'a-private.md',
    filePath: 'a-private.md',
    chunkIndex: 0,
    totalChunks: 1,
  });
  chunks.push({
    id: 'b-priv-0',
    ownerId: USER_B,
    visibility: 'private',
    chunk: 'b-private-unique-marker bravo private',
    fileName: 'b-private.md',
    filePath: 'b-private.md',
    chunkIndex: 0,
    totalChunks: 1,
  });
  chunks.push({
    id: 'b-pub-0',
    ownerId: USER_B,
    visibility: 'public',
    chunk: 'b-public-unique-marker charlie public',
    fileName: 'b-public.md',
    filePath: 'b-public.md',
    chunkIndex: 0,
    totalChunks: 1,
  });
  // Legacy shared — ownerId = NO_OWNER_SENTINEL, visibility = public.
  chunks.push({
    id: 'shared-0',
    ownerId: '',
    visibility: 'public',
    chunk: 'shared-legacy-marker delta shared',
    fileName: 'shared.md',
    filePath: 'shared.md',
    chunkIndex: 0,
    totalChunks: 1,
  });
}

function visibilityMatch(viewerId: string): MockChunk[] {
  return chunks.filter((c) => c.visibility === 'public' || c.ownerId === viewerId);
}

function toQdrantPoint(c: MockChunk): Record<string, unknown> {
  return {
    id: c.id,
    vector: [0.1, 0.2],
    payload: {
      chunk: c.chunk,
      fileName: c.fileName,
      fileType: '.md',
      filePath: c.filePath,
      chunkIndex: c.chunkIndex,
      totalChunks: c.totalChunks,
      ownerId: c.ownerId,
      visibility: c.visibility,
    },
    score: 0.9,
  };
}

const mockQueryImpl = async (
  _collection: string,
  opts: Record<string, unknown> | undefined
): Promise<Record<string, unknown>[]> => {
  const filter = opts?.filter as { must?: unknown[] } | undefined;
  if (!filter || !filter.must || filter.must.length === 0) {
    return visibilityMatch('').map(toQdrantPoint);
  }
  // Qdrant semantics: top-level must = AND of all clauses. A
  // should group inside a must item = OR with default min 1.
  // So `must: [shouldGroup, filePath, chunkIndex]` means
  //   (visibility OR ownerId) AND filePath AND chunkIndex.
  // Track a working set: each clause narrows it (AND), and the
  // should group also narrows (intersection with the visibility set).
  const must = filter.must;
  let working: MockChunk[] | null = null;
  for (const clause of must) {
    const c = clause as Record<string, unknown>;
    if (c.should && Array.isArray(c.should)) {
      const should = c.should as Array<Record<string, unknown>>;
      const ownerClause = should.find(
        (s) => s.key === 'ownerId' && (s.match as { value?: string } | undefined)?.value !== 'public'
      );
      const viewerId = ownerClause
        ? ((ownerClause.match as { value: string }).value)
        : '';
      const visibilityFiltered = visibilityMatch(viewerId);
      if (working === null) {
        working = visibilityFiltered;
      } else {
        const allowed = new Set(visibilityFiltered.map((x) => x.id));
        working = working.filter((x) => allowed.has(x.id));
      }
    } else if (c.key === 'filePath') {
      const value = (c.match as { value: string }).value;
      const set = working ?? chunks;
      working = set.filter((x) => x.filePath === value);
    } else if (c.key === 'chunkIndex') {
      const value = (c.match as { value: number }).value;
      const set = working ?? chunks;
      working = set.filter((x) => x.chunkIndex === value);
    } else if (c.key === 'headingPath') {
      // Heading-path narrowing isn't exercised here.
    }
  }
  return (working ?? []).map(toQdrantPoint);
};

const {
  mockQuery,
  wrappedQuery,
  mockSetPayload,
  mockGetCollections,
  mockCreatePayloadIndex,
  capturedFilters,
} = vi.hoisted(() => {
  // Inner vi.fn — captures call args so the wrapper can record the
  // filter without depending on mockResolvedValueOnce queue state
  // (vi.clearAllMocks does NOT reset the queue).
  const innerMockQuery = vi.fn(async (...args: unknown[]) =>
    (mockQueryImpl as (...a: unknown[]) => unknown)(...args) as Awaited<ReturnType<typeof mockQueryImpl>>
  );
  const filterLog: Array<{ must?: unknown[] } | undefined> = [];
  const wrapper = vi.fn(async (...args: unknown[]) => {
    const opts = args[1] as Record<string, unknown> | undefined;
    filterLog.push(opts?.filter as { must?: unknown[] } | undefined);
    return innerMockQuery(...args);
  });
  return {
    mockQuery: innerMockQuery,
    wrappedQuery: wrapper,
    mockSetPayload: vi.fn(async (_collection: string, _opts: unknown) => ({ result: { status: 'acknowledged' } })),
    mockGetCollections: vi.fn(async () => ({ collections: [{ name: 'documents_visibility_test' }] })),
    mockCreatePayloadIndex: vi.fn(async () => ({})),
    capturedFilters: filterLog,
  };
});

vi.mock('@qdrant/qdrant-js', () => ({
  QdrantClient: class {
    getCollections = mockGetCollections;
    createPayloadIndex = mockCreatePayloadIndex;
    setPayload = mockSetPayload;
    query = wrappedQuery;
  },
}));

import {
  buildVisibilityFilter,
  searchChunks,
  expandHits,
  fetchByFilePathAndIndex,
  fetchByFilePathAndHeadingPath,
  setOwnerVisibility,
  NO_OWNER_SENTINEL,
  type Visibility,
  type DocumentChunk,
} from '../../src/services/qdrant.js';

beforeEach(() => {
  vi.clearAllMocks();
  capturedFilters.length = 0;
  seedChunks();
});

describe('buildVisibilityFilter', () => {
  it('builds the should group: visibility=public OR ownerId=viewer', () => {
    const f = buildVisibilityFilter(USER_A);
    expect(f.must).toHaveLength(1);
    const group = (f.must as Array<Record<string, unknown>>)[0];
    expect(group.should).toEqual([
      { key: 'visibility', match: { value: 'public' } },
      { key: 'ownerId', match: { value: USER_A } },
    ]);
  });
});

describe('searchChunks with viewerId', () => {
  it("returns A's own private chunks", async () => {
    const results = await searchChunks([0.1], {}, USER_A);
    expect(results.map((r) => r.id)).toContain('a-priv-0');
  });

  it("never returns B's private chunks to A", async () => {
    const results = await searchChunks([0.1], {}, USER_A);
    expect(results.map((r) => r.id)).not.toContain('b-priv-0');
  });

  it("returns B's public chunks to A", async () => {
    const results = await searchChunks([0.1], {}, USER_A);
    expect(results.map((r) => r.id)).toContain('b-pub-0');
  });

  it("returns A's own + public + legacy shared, never B's private", async () => {
    const results = await searchChunks([0.1], {}, USER_A);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('a-priv-0');  // own private
    expect(ids).toContain('b-pub-0');   // foreign public
    expect(ids).toContain('shared-0');  // legacy shared
    expect(ids).not.toContain('b-priv-0'); // foreign private
  });

  it('B does not see A private when B searches', async () => {
    const results = await searchChunks([0.1], {}, USER_B);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('b-priv-0'); // own private
    expect(ids).toContain('b-pub-0');  // own public
    expect(ids).not.toContain('a-priv-0'); // foreign private
  });

  it('merges the visibility clause with fileName/fileType filters', async () => {
    await searchChunks([0.1], { fileName: 'b-public.md' }, USER_A);
    const filter = capturedFilters[0];
    const json = JSON.stringify(filter);
    expect(json).toContain('b-public.md');
    const shouldGroup = (filter?.must ?? []).find(
      (m) => (m as Record<string, unknown>).should
    ) as Record<string, unknown> | undefined;
    expect(JSON.stringify(shouldGroup)).toContain('visibility');
    expect(JSON.stringify(shouldGroup)).toContain(USER_A);
  });

  it('sends NO_OWNER_SENTINEL as the ownerId value when no viewer is threaded (preserves Phase-03 behavior)', async () => {
    // A caller that hasn't been threaded yet still gets the
    // visibility clause — with viewerId='', the should group
    // matches public OR ownerId=''. Legacy shared chunks have
    // ownerId='', so they pass. Other private chunks do not.
    const results = await searchChunks([0.1], {});
    const ids = results.map((r) => r.id);
    expect(ids).toContain('shared-0'); // ownerId='' passes the ownerId clause
    expect(ids).toContain('b-pub-0');  // public visibility passes
    expect(ids).not.toContain('a-priv-0'); // private + non-empty ownerId fails both
    expect(ids).not.toContain('b-priv-0');
  });

  it('viewer C sees only public + legacy shared, not A or B privates', async () => {
    const results = await searchChunks([0.1], {}, USER_C);
    const ids = results.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['b-pub-0', 'shared-0']));
    expect(ids).not.toContain('a-priv-0');
    expect(ids).not.toContain('b-priv-0');
  });
});

describe('expandHits with viewerId', () => {
  it('threads viewerId through the siblings fetch filter', async () => {
    // The hit needs totalChunks > 1 so siblings exist to fetch.
    const hit = toDocumentChunk({ ...chunks[0], totalChunks: 3, chunkIndex: 1 });
    await expandHits([hit], { mode: 'siblings' }, USER_A);
    // The last captured filter is the sibling fetch — it must
    // include the viewerId clause.
    const siblingFilter = capturedFilters[capturedFilters.length - 1];
    expect(JSON.stringify(siblingFilter)).toContain(USER_A);
  });

  it('does not surface b-priv-0 as a sibling when viewer is A', async () => {
    const hit = toDocumentChunk({ ...chunks[0], totalChunks: 3, chunkIndex: 1 });
    const result = await expandHits([hit], { mode: 'siblings', siblingsRange: 1 }, USER_A);
    expect(result.map((r) => r.id)).not.toContain('b-priv-0');
  });
});

describe('fetchByFilePathAndIndex with viewerId', () => {
  it("returns A's own chunk when viewer is A", async () => {
    const results = await fetchByFilePathAndIndex('a-private.md', 0, USER_A);
    expect(results.map((r) => r.id)).toEqual(['a-priv-0']);
  });

  it("returns empty when A asks for B's private chunk", async () => {
    // a-priv-0 filePath is 'a-private.md'; b-priv-0 filePath is
    // 'b-private.md'. When viewer=A asks for b-private.md, the
    // filePath clause excludes everything, so the sibling filter
    // doesn't even run visibility (narrowed=[]).
    const results = await fetchByFilePathAndIndex('b-private.md', 0, USER_A);
    expect(results).toEqual([]);
  });

  it('merges the visibility clause into the filePath/chunkIndex filter', async () => {
    await fetchByFilePathAndIndex('a-private.md', 0, USER_A);
    const filter = capturedFilters[0];
    const json = JSON.stringify(filter);
    expect(json).toContain('a-private.md');
    expect(json).toContain('"value":0'); // chunkIndex match.value=0
    const shouldGroup = (filter?.must ?? []).find(
      (m) => (m as Record<string, unknown>).should
    ) as Record<string, unknown> | undefined;
    expect(JSON.stringify(shouldGroup)).toContain(USER_A);
  });
});

describe('fetchByFilePathAndHeadingPath with viewerId', () => {
  it('returns a-priv-0 to A', async () => {
    const results = await fetchByFilePathAndHeadingPath('a-private.md', [], USER_A);
    expect(results.map((r) => r.id)).toEqual(['a-priv-0']);
  });

  it('does not return b-priv-0 to A', async () => {
    const results = await fetchByFilePathAndHeadingPath('b-private.md', [], USER_A);
    expect(results).toEqual([]);
  });
});

describe('setOwnerVisibility flips visibility', () => {
  it("after A's private file flips to public, B sees it", async () => {
    // First: B's search returns nothing from a-private.md.
    const beforeResults = await searchChunks([0.1], {}, USER_B);
    expect(beforeResults.map((r) => r.payload.filePath)).not.toContain('a-private.md');

    // A flips the file to public.
    const vis: Visibility = 'public';
    await setOwnerVisibility('a-private.md', USER_A, vis);

    // Mutate the in-memory chunk so the next query reflects the flip.
    chunks[0].visibility = 'public';

    // Now B sees the chunk.
    const afterResults = await searchChunks([0.1], {}, USER_B);
    expect(afterResults.map((r) => r.payload.filePath)).toContain('a-private.md');

    // The setPayload call carried ownerId=A + visibility=public.
    const payloadCall = mockSetPayload.mock.calls[0];
    expect(payloadCall[1].payload).toEqual({
      ownerId: USER_A,
      visibility: 'public',
    });
  });

  it('NO_OWNER_SENTINEL is the empty string', () => {
    expect(NO_OWNER_SENTINEL).toBe('');
  });
});

// Helpers — adapt the mock chunk shape to what the production code
// expects (used in expandHits inputs).

function toDocumentChunk(c: MockChunk): DocumentChunk {
  return toQdrantPoint(c) as unknown as DocumentChunk;
}