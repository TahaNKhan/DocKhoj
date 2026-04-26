import { QdrantClient } from '@qdrant/qdrant-js';
import { v4 as uuidv4 } from 'uuid';
import { qdrantLog as log } from '../utils/logger.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'documents';
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '768', 10);

export interface DocumentChunk {
  id: string;
  vector: number[];
  payload: {
    chunk: string;
    fileName: string;
    fileType: string;
    filePath: string;
    chunkIndex: number;
    totalChunks: number;
  };
  score?: number;
}

const client = new QdrantClient({ url: QDRANT_URL });

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
}

export async function upsertChunk(chunk: DocumentChunk): Promise<void> {
  log.info({ chunkId: chunk.id }, 'Upserting single chunk');
  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: [
      {
        id: chunk.id,
        vector: chunk.vector,
        payload: chunk.payload,
      },
    ],
  });
}

export async function upsertChunks(chunks: DocumentChunk[]): Promise<void> {
  if (chunks.length === 0) return;

  log.info({ chunkCount: chunks.length }, 'Upserting chunks');
  const startTime = Date.now();

  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: chunks.map((chunk) => ({
      id: chunk.id,
      vector: chunk.vector,
      payload: chunk.payload,
    })),
  });

  log.info({ elapsedMs: Date.now() - startTime }, 'Upsert complete');
}

export async function searchChunks(
  queryVector: number[],
  limit: number = 5
): Promise<DocumentChunk[]> {
  log.info({ limit }, 'Searching');
  const results = await client.search(COLLECTION_NAME, {
    vector: queryVector,
    limit,
    with_payload: true,
  });
  log.info({ resultCount: results.length }, 'Search complete');

  return results.map((result) => ({
    id: result.id as string,
    vector: result.vector as number[],
    payload: result.payload as DocumentChunk['payload'],
    score: result.score,
  }));
}

export async function deleteChunk(id: string): Promise<void> {
  log.info({ chunkId: id }, 'Deleting chunk');
  await client.delete(COLLECTION_NAME, {
    points: [id],
  });
}

export async function getCollectionInfo() {
  return await client.getCollection(COLLECTION_NAME);
}