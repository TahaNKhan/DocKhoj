import { QdrantClient } from '@qdrant/qdrant-js';
import { qdrantLog as log } from '../utils/logger.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'documents';
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '768', 10);

// Phase 04 / p4-T03 — small key/value collection used to gate
// one-shot migrations and other app-level bookkeeping. Each point
// stores `{ key: <logical-name>, value: string }`; the point ID is
// a UUID (Qdrant requires UUID or unsigned-integer IDs — strings
// are rejected).
const METADATA_COLLECTION = process.env.QDRANT_METADATA_COLLECTION || 'app_metadata';
const METADATA_VECTOR_SIZE = 1;
const MIGRATION_FLAG_KEY = 'phase_04_qdrant_migration_applied';
const MIGRATION_SCAN_BATCH = 100;

// Fixed UUID for the migration flag's metadata point. Stable across
// boots so getMetadata finds the previously-written value. If we
// ever add more flags, switch to a namespace UUID v5 — one literal
// is enough today.
const MIGRATION_FLAG_POINT_ID = '00000000-0000-4000-8000-000000000001';

export type Visibility = 'public' | 'private';

// ponytail: Qdrant 1.17's `setPayload` interprets `null` as "delete
// the key" — verified empirically against a real qdrant container.
// The design says `ownerId: string | null`, but at the storage layer
// we can't keep a literal null. Use the empty string as the sentinel
// for "no owner". The buildVisibilityFilter clause `match: { value:
// viewerId }` won't match "" for any real viewerId, so semantics
// are preserved.
export const NO_OWNER_SENTINEL = '';

export interface DocumentChunkPayload {
  chunk: string;
  fileName: string;
  fileType: string;
  filePath: string;
  chunkIndex: number;
  totalChunks: number;
  blockKind?: string;
  headingPath?: string[];
  pageNumber?: number;
  tokenCount?: number;
}

export interface DocumentChunk {
  id: string;
  vector: number[];
  payload: DocumentChunkPayload;
  score?: number;
}

export interface SearchOptions {
  limit?: number;
  fileName?: string;
  fileType?: string;
  pageNumber?: number;
}

export type ExpandMode = 'none' | 'siblings' | 'sections';

export interface ExpandOptions {
  mode: ExpandMode;
  siblingsRange?: number;
  siblingsCap?: number;
  sectionsCap?: number;
}

const client = new QdrantClient({ url: QDRANT_URL });

interface QdrantFilter {
  must?: Array<Record<string, unknown>>;
  should?: Array<Record<string, unknown>>;
  must_not?: Array<Record<string, unknown>>;
}

function buildSearchFilter(opts: SearchOptions): QdrantFilter | undefined {
  const must: Array<Record<string, unknown>> = [];
  if (opts.fileName) must.push({ key: 'fileName', match: { value: opts.fileName } });
  if (opts.fileType) must.push({ key: 'fileType', match: { value: opts.fileType } });
  if (typeof opts.pageNumber === 'number') {
    must.push({ key: 'pageNumber', match: { value: opts.pageNumber } });
  }
  return must.length > 0 ? { must } : undefined;
}

// Phase 04 / p4-T08 / FR-32 — every Qdrant query for the requester
// must include this clause. The should group matches EITHER a
// public chunk OR a chunk owned by `viewerId`. `ownerId: ''` is the
// NO_OWNER_SENTINEL (legacy/shared rows) — it never matches a real
// viewerId, so shared files only surface via the visibility clause.
// ponytail: default viewerId = NO_OWNER_SENTINEL — until T11/T12
// threads `request.user.id` through the route handlers, every call
// site that hasn't been updated yet still gets Phase-03 behavior
// (public + shared visible). The clause is still always merged;
// caller-passed viewerIds just narrow it.
export function buildVisibilityFilter(viewerId: string): QdrantFilter {
  return {
    must: [
      {
        should: [
          { key: 'visibility', match: { value: 'public' } },
          { key: 'ownerId', match: { value: viewerId } },
        ],
      },
    ],
  };
}

// Merge an existing optional filter (from buildSearchFilter) with
// the visibility clause into one `must` clause. Both pieces land
// inside `must` so the AND with the visibility should-group is
// honored. `buildVisibilityFilter` is the single source of truth
// for the should group; never inline it.
function mergeWithVisibility(
  existing: QdrantFilter | undefined,
  viewerId: string
): QdrantFilter {
  const vis = buildVisibilityFilter(viewerId);
  return {
    must: [
      ...(existing?.must ?? []),
      ...vis.must!,
    ],
  };
}

export async function initCollection(): Promise<void> {
  log.info({ url: QDRANT_URL }, 'Connecting to Qdrant');
  const collections = await client.getCollections();
  log.info({ collectionCount: collections.collections.length }, 'Connected to Qdrant');
  const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

  if (!exists) {
    log.info({ collection: COLLECTION_NAME }, 'Creating collection');
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: VECTOR_SIZE,
        distance: 'Cosine',
      },
    });
    log.info({ collection: COLLECTION_NAME }, 'Collection created');
  } else {
    log.info({ collection: COLLECTION_NAME }, 'Collection already exists');
  }

  await ensurePayloadIndexes();
}

// Phase 04 / p4-T03 — ensure the small `app_metadata` collection
// exists. Called by both initCollection (with the existing
// collections list) and migratePayloads (standalone boot path).
// Idempotent.
export async function ensureMetadataCollection(): Promise<void> {
  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === METADATA_COLLECTION);
  if (exists) return;
  await client.createCollection(METADATA_COLLECTION, {
    vectors: { size: METADATA_VECTOR_SIZE, distance: 'Cosine' },
  });
  log.info({ collection: METADATA_COLLECTION }, 'Created metadata collection');
}

export async function getMetadata(key: string): Promise<string | null> {
  try {
    const rows = (await client.retrieve(METADATA_COLLECTION, {
      ids: [metadataPointIdFor(key)] as unknown as Array<string | number>,
      with_payload: true,
      with_vector: false,
    } as unknown as Parameters<typeof client.retrieve>[1])) as Array<{
      id?: string | number;
      payload?: Record<string, unknown> | null;
    }>;
    const row = rows[0];
    if (!row || !row.payload) return null;
    const value = row.payload.value;
    return typeof value === 'string' ? value : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message, key }, 'getMetadata failed');
    return null;
  }
}

export async function setMetadata(key: string, value: string): Promise<void> {
  await client.upsert(METADATA_COLLECTION, {
    wait: true,
    points: [
      {
        id: metadataPointIdFor(key),
        vector: new Array(METADATA_VECTOR_SIZE).fill(0),
        payload: { key, value },
      },
    ],
  } as unknown as Parameters<typeof client.upsert>[1]);
}

// ponytail: one-flag-one-literal — only the migration flag exists
// today. When the second flag lands, replace with uuidv5 against a
// stable namespace.
function metadataPointIdFor(key: string): string {
  if (key === MIGRATION_FLAG_KEY) return MIGRATION_FLAG_POINT_ID;
  throw new Error(`Unknown metadata key: ${key}`);
}

async function ensurePayloadIndexes(): Promise<void> {
  const keywordFields = [
    'fileName',
    'filePath',
    'fileType',
    // Phase 04 / p4-T03 / FR-33 — owner + visibility indexes for
    // the buildVisibilityFilter clause. Both keyword schema.
    'ownerId',
    'visibility',
  ];
  for (const field of keywordFields) {
    try {
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: field,
        field_schema: 'keyword',
        wait: true,
      });
      log.info({ field }, 'Created payload index');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already exists|Index already exists/i.test(message)) {
        log.debug({ field }, 'Payload index already exists');
      } else {
        log.warn({ err: message, field }, 'Failed to create payload index');
      }
    }
  }
  try {
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'pageNumber',
      field_schema: 'integer',
      wait: true,
    });
    log.info({ field: 'pageNumber' }, 'Created payload index');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists|Index already exists/i.test(message)) {
      log.debug({ field: 'pageNumber' }, 'Payload index already exists');
    } else {
      log.warn({ err: message, field: 'pageNumber' }, 'Failed to create payload index');
    }
  }
}

// Phase 04 / p4-T03 / FR-29 — stamp ownerId + visibility on every
// chunk of a given file. `fileId` is the chunk payload's `filePath`
// value (the on-disk basename = `${fileId}${ext}`); filtering by
// that field uniquely identifies the chunks of one file. Uses
// Qdrant's set_payload with a filter so we don't need to scroll
// + enumerate point IDs first. `ownerId: null` is mapped to
// NO_OWNER_SENTINEL — see that constant for why.
export async function setOwnerVisibility(
  fileId: string,
  ownerId: string | null,
  visibility: Visibility
): Promise<void> {
  await client.setPayload(COLLECTION_NAME, {
    wait: true,
    payload: {
      ownerId: ownerId ?? NO_OWNER_SENTINEL,
      visibility,
    },
    filter: {
      must: [{ key: 'filePath', match: { value: fileId } }],
    },
  } as unknown as Parameters<typeof client.setPayload>[1]);
}

// Phase 04 / p4-T03 / FR-31 — one-shot migration that stamps
// `ownerId = NO_OWNER_SENTINEL, visibility = 'public'` on every
// chunk that doesn't already have both fields. (Qdrant 1.17
// treats null as a delete — see NO_OWNER_SENTINEL.) Idempotent;
// gated by an app_metadata flag so subsequent boots are no-ops.
export async function migratePayloads(): Promise<{
  scanned: number;
  updated: number;
  alreadyMigrated: boolean;
}> {
  await ensureMetadataCollection();
  const flag = await getMetadata(MIGRATION_FLAG_KEY);
  if (flag !== null) {
    log.info({ migratedAt: flag }, 'Qdrant payload migration already applied');
    return { scanned: 0, updated: 0, alreadyMigrated: true };
  }

  log.info('Running Qdrant payload migration');
  let scanned = 0;
  let updated = 0;
  let offset: string | number | Record<string, unknown> | undefined = undefined;

  // ponytail: scan-then-batch — read one page, write that page's
  // updates, advance. Memory bounded by MIGRATION_SCAN_BATCH. If
  // collections grow past ~1M points, swap to a parallel scroll +
  // async writes; today the self-hosted profile is small enough
  // that the simple loop is fine.
  while (true) {
    const result = (await client.scroll(COLLECTION_NAME, {
      limit: MIGRATION_SCAN_BATCH,
      offset,
      with_payload: true,
      with_vector: false,
    } as unknown as Parameters<typeof client.scroll>[1])) as {
      points?: Array<{ id: string | number; payload?: Record<string, unknown> | null }>;
      next_page_offset?: string | number | Record<string, unknown> | null;
    };

    const points = result.points ?? [];
    if (points.length === 0) break;

    const toUpdate: Array<string | number> = [];
    for (const point of points) {
      scanned++;
      const payload = point.payload ?? {};
      if (!('ownerId' in payload) || !('visibility' in payload)) {
        toUpdate.push(point.id);
      }
    }

    if (toUpdate.length > 0) {
      await client.setPayload(COLLECTION_NAME, {
        wait: true,
        payload: { ownerId: NO_OWNER_SENTINEL, visibility: 'public' },
        points: toUpdate as unknown as Array<string | number>,
      } as unknown as Parameters<typeof client.setPayload>[1]);
      updated += toUpdate.length;
    }

    const next = result.next_page_offset;
    if (next === undefined || next === null) break;
    offset = next as unknown as typeof offset;
  }

  await setMetadata(MIGRATION_FLAG_KEY, new Date().toISOString());
  log.info({ scanned, updated }, 'Qdrant payload migration complete');
  return { scanned, updated, alreadyMigrated: false };
}

export async function upsertChunk(chunk: DocumentChunk): Promise<void> {
  log.debug({ chunkId: chunk.id }, 'Upserting single chunk');
  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: [
      {
        id: chunk.id,
        vector: chunk.vector,
        payload: chunk.payload as unknown as Record<string, unknown>,
      },
    ],
  });
}

export async function upsertChunks(chunks: DocumentChunk[]): Promise<void> {
  if (chunks.length === 0) return;

  log.debug({ chunkCount: chunks.length }, 'Upserting chunks');
  const startTime = Date.now();

  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: chunks.map((chunk) => ({
      id: chunk.id,
      vector: chunk.vector,
      payload: chunk.payload as unknown as Record<string, unknown>,
    })),
  });

  log.debug({ elapsedMs: Date.now() - startTime }, 'Upsert complete');
}

export async function searchChunks(
  queryVector: number[],
  opts: SearchOptions = {},
  // Phase 04 / p4-T08 / FR-32 — viewer's id used by
  // buildVisibilityFilter. Optional with NO_OWNER_SENTINEL default
  // so Phase-03 callers that haven't been threaded yet still get
  // Phase-03 (public + shared) behavior.
  viewerId: string = NO_OWNER_SENTINEL
): Promise<DocumentChunk[]> {
  const limit = opts.limit ?? 5;
  const filter = mergeWithVisibility(buildSearchFilter(opts), viewerId);
  log.debug({ limit, hasFilter: !!filter }, 'Searching');

  const response = await client.query(COLLECTION_NAME, {
    query: queryVector,
    limit,
    filter: filter as unknown as Record<string, unknown> | undefined,
    with_payload: true,
  });

  const results = (Array.isArray(response) ? response : response.points ?? []) as Array<{
    id: string | number;
    vector?: number[] | number[][] | Record<string, unknown> | null;
    payload?: Record<string, unknown> | null;
    score?: number;
  }>;
  log.debug({ resultCount: results.length }, 'Search complete');

  return results.map((result) => ({
    id: String(result.id),
    vector: Array.isArray(result.vector) && Array.isArray(result.vector[0])
      ? (result.vector as number[][]).flat()
      : ((result.vector as number[] | undefined) ?? []),
    payload: result.payload as unknown as DocumentChunkPayload,
    score: result.score,
  }));
}

async function _fetchByFilePathAndIndex(
  filePath: string,
  chunkIndex: number,
  viewerId: string = NO_OWNER_SENTINEL
): Promise<DocumentChunk[]> {
  try {
    const response = await client.query(COLLECTION_NAME, {
      query: undefined as unknown as number[],
      filter: mergeWithVisibility(
        {
          must: [
            { key: 'filePath', match: { value: filePath } },
            { key: 'chunkIndex', match: { value: chunkIndex } },
          ],
        },
        viewerId
      ) as unknown as Record<string, unknown>,
      limit: 1,
      with_payload: true,
    });
    const results = (Array.isArray(response) ? response : response.points ?? []) as Array<{
      id: string | number;
      vector?: number[] | number[][] | Record<string, unknown> | null;
      payload?: Record<string, unknown> | null;
    }>;
    return results.map((result) => ({
      id: String(result.id),
      vector: Array.isArray(result.vector) && Array.isArray(result.vector[0])
        ? (result.vector as number[][]).flat()
        : ((result.vector as number[] | undefined) ?? []),
      payload: result.payload as unknown as DocumentChunkPayload,
    }));
  } catch (err) {
    log.warn({ err, filePath, chunkIndex }, 'fetchByFilePathAndIndex failed');
    return [];
  }
}

async function _fetchByFilePathAndHeadingPath(
  filePath: string,
  headingPath: string[],
  viewerId: string = NO_OWNER_SENTINEL
): Promise<DocumentChunk[]> {
  try {
    const response = await client.query(COLLECTION_NAME, {
      query: undefined as unknown as number[],
      filter: mergeWithVisibility(
        {
          must: [
            { key: 'filePath', match: { value: filePath } },
            { key: 'headingPath', match: { value: headingPath } },
          ],
        },
        viewerId
      ) as unknown as Record<string, unknown>,
      limit: 50,
      with_payload: true,
    });
    const results = (Array.isArray(response) ? response : response.points ?? []) as Array<{
      id: string | number;
      vector?: number[] | number[][] | Record<string, unknown> | null;
      payload?: Record<string, unknown> | null;
    }>;
    return results.map((result) => ({
      id: String(result.id),
      vector: Array.isArray(result.vector) && Array.isArray(result.vector[0])
        ? (result.vector as number[][]).flat()
        : ((result.vector as number[] | undefined) ?? []),
      payload: result.payload as unknown as DocumentChunkPayload,
    }));
  } catch (err) {
    log.warn({ err, filePath }, 'fetchByFilePathAndHeadingPath failed');
    return [];
  }
}

export async function expandHits(
  hits: DocumentChunk[],
  options: ExpandOptions,
  viewerId: string = NO_OWNER_SENTINEL
): Promise<DocumentChunk[]> {
  if (options.mode === 'none' || hits.length === 0) return hits;

  const siblingsRange = options.siblingsRange ?? 2;
  const siblingsCap = options.siblingsCap ?? 15;
  const sectionsCap = options.sectionsCap ?? 20;

  const seen = new Set<string>(hits.map((h) => h.id));
  const expanded: DocumentChunk[] = [...hits];

  if (options.mode === 'siblings') {
    for (const hit of hits) {
      for (let delta = -siblingsRange; delta <= siblingsRange; delta++) {
        if (delta === 0) continue;
        const targetIndex = hit.payload.chunkIndex + delta;
        if (targetIndex < 0 || targetIndex >= hit.payload.totalChunks) continue;
        const neighbors = await _fetchByFilePathAndIndex(hit.payload.filePath, targetIndex, viewerId);
        for (const n of neighbors) {
          if (seen.has(n.id)) continue;
          seen.add(n.id);
          expanded.push(n);
          if (expanded.length >= siblingsCap) return expanded;
        }
      }
      if (expanded.length >= siblingsCap) break;
    }
    return expanded;
  }

  if (options.mode === 'sections') {
    for (const hit of hits) {
      const headingPath = hit.payload.headingPath ?? [];
      if (headingPath.length === 0) continue;
      const sectionChunks = await _fetchByFilePathAndHeadingPath(hit.payload.filePath, headingPath, viewerId);
      for (const s of sectionChunks) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        expanded.push(s);
        if (expanded.length >= sectionsCap) return expanded;
      }
      if (expanded.length >= sectionsCap) break;
    }
    return expanded;
  }

  return expanded;
}

export async function deleteChunk(id: string): Promise<void> {
  log.debug({ chunkId: id }, 'Deleting chunk');
  await client.delete(COLLECTION_NAME, {
    points: [id],
  });
}

// Phase 03 / p3-T02: filter-based bulk delete (FR-4, FR-29, FR-5).
// Removes every point whose payload.filePath equals `filePath`.
// Returns the number of points deleted; 0 when the filter matches
// nothing (idempotent — safe to call on collections that don't
// have any matching chunks). The Qdrant JS SDK's response shape
// varies between sync and async delete; we accept both.
export async function deleteByFilePath(filePath: string): Promise<number> {
  log.debug({ filePath }, 'Deleting chunks by filePath');
  const result = (await client.delete(COLLECTION_NAME, {
    filter: {
      must: [{ key: 'filePath', match: { value: filePath } }],
    } as unknown as Record<string, unknown>,
  })) as unknown as Record<string, unknown>;

  const inner = (result.result ?? {}) as Record<string, unknown>;
  const deleted = typeof inner.deleted === 'number'
    ? inner.deleted
    : typeof inner.deleted_count === 'number'
      ? inner.deleted_count
      : 0;

  log.info({ filePath, deleted }, 'Chunks deleted by filePath');
  return deleted;
}

// Phase 03 / p3-T02: the two internal helpers are promoted to
// public exports so the agent-tools module (p3-T05) can reuse them
// for the get_neighbor_chunks and get_section_chunks tools.
// Phase 04 / p4-T08 / FR-32: viewerId is optional — see the
// searchChunks comment for the default rationale.
export async function fetchByFilePathAndIndex(
  filePath: string,
  chunkIndex: number,
  viewerId: string = NO_OWNER_SENTINEL
): Promise<DocumentChunk[]> {
  return _fetchByFilePathAndIndex(filePath, chunkIndex, viewerId);
}

export async function fetchByFilePathAndHeadingPath(
  filePath: string,
  headingPath: string[],
  viewerId: string = NO_OWNER_SENTINEL
): Promise<DocumentChunk[]> {
  return _fetchByFilePathAndHeadingPath(filePath, headingPath, viewerId);
}

export async function getCollectionInfo() {
  return await client.getCollection(COLLECTION_NAME);
}

export { client as qdrantClient, COLLECTION_NAME as QDRANT_COLLECTION };