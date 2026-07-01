import { QdrantClient } from '@qdrant/qdrant-js';
import { qdrantLog as log } from '../utils/logger.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'documents';
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '768', 10);

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

async function ensurePayloadIndexes(): Promise<void> {
  const keywordFields = ['fileName', 'filePath', 'fileType'];
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
  opts: SearchOptions = {}
): Promise<DocumentChunk[]> {
  const limit = opts.limit ?? 5;
  const filter = buildSearchFilter(opts);
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

async function fetchByFilePathAndIndex(
  filePath: string,
  chunkIndex: number
): Promise<DocumentChunk[]> {
  try {
    const response = await client.query(COLLECTION_NAME, {
      query: undefined as unknown as number[],
      filter: {
        must: [
          { key: 'filePath', match: { value: filePath } },
          { key: 'chunkIndex', match: { value: chunkIndex } },
        ],
      } as unknown as Record<string, unknown>,
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

async function fetchByFilePathAndHeadingPath(
  filePath: string,
  headingPath: string[]
): Promise<DocumentChunk[]> {
  try {
    const response = await client.query(COLLECTION_NAME, {
      query: undefined as unknown as number[],
      filter: {
        must: [
          { key: 'filePath', match: { value: filePath } },
          { key: 'headingPath', match: { value: headingPath } },
        ],
      } as unknown as Record<string, unknown>,
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
  options: ExpandOptions
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
        const neighbors = await fetchByFilePathAndIndex(hit.payload.filePath, targetIndex);
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
      const sectionChunks = await fetchByFilePathAndHeadingPath(hit.payload.filePath, headingPath);
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

export async function getCollectionInfo() {
  return await client.getCollection(COLLECTION_NAME);
}

export { client as qdrantClient, COLLECTION_NAME as QDRANT_COLLECTION };