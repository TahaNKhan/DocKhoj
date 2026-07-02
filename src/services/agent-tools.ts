import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import type Database from 'better-sqlite3';
import {
  fetchByFilePathAndIndex,
  fetchByFilePathAndHeadingPath,
  qdrantClient,
  QDRANT_COLLECTION,
  type DocumentChunk,
} from './qdrant.js';
import { DocumentStore, type DocumentRow } from './document-store.js';
import { chatLog as log } from '../utils/logger.js';

// Phase 03 / p3-T05 — agent tool definitions + execution dispatcher.
//
// Four tools are exposed to the LLM via the OpenAI `tools` parameter
// when `expand=auto` is requested (FR-14, FR-30). They are pure
// functions over the existing services — no business logic in the
// route handler:
//   1. get_neighbor_chunks — fetch chunks ±range around a given chunk
//      in the same document.
//   2. get_section_chunks — fetch all chunks in the same
//      `headingPath` within the same document.
//   3. get_chunk — fetch a single chunk by its ID.
//   4. get_document — fetch document metadata by `filePath`.
//
// Each tool returns a JSON-serializable value or a structured error.
// The agent loop (`services/agent-loop.ts`) consumes these results,
// applies the per-iteration token cap, and forwards them to the LLM
// via `tool` messages.

type DB = Database.Database;

export type AgentToolName =
  | 'get_neighbor_chunks'
  | 'get_section_chunks'
  | 'get_chunk'
  | 'get_document';

const VALID_TOOL_NAMES: ReadonlySet<AgentToolName> = new Set([
  'get_neighbor_chunks',
  'get_section_chunks',
  'get_chunk',
  'get_document',
]);

export function isAgentToolName(name: string): name is AgentToolName {
  return VALID_TOOL_NAMES.has(name as AgentToolName);
}

const NEIGHBOR_RANGE_MAX = 5;
const NEIGHBOR_RANGE_DEFAULT = 2;

// A flat, JSON-serializable projection of a DocumentChunk — what the
// LLM and the SPA both consume. Mirrors the shape of
// `DocumentChunkPayload` plus an explicit `chunkId`.
export interface ToolChunk {
  chunkId: string;
  fileName: string;
  filePath: string;
  chunkIndex: number;
  totalChunks: number;
  pageNumber?: number;
  headingPath?: string[];
  text: string;
  blockKind?: string;
  tokenCount?: number;
}

export type AgentToolResult =
  | { kind: 'chunks'; chunks: ToolChunk[]; truncated: boolean }
  | { kind: 'document'; document: DocumentRow | null }
  | { kind: 'error'; code: 'NOT_FOUND' | 'INVALID_ARG'; message: string };

export function invalidArg(message: string): AgentToolResult {
  return { kind: 'error', code: 'INVALID_ARG', message };
}

export function notFound(message: string): AgentToolResult {
  return { kind: 'error', code: 'NOT_FOUND', message };
}

// Convert a DocumentChunk (the canonical Qdrant result) to the flat
// ToolChunk shape that both the LLM and the SPA render.
function toToolChunk(c: DocumentChunk): ToolChunk {
  return {
    chunkId: c.id,
    fileName: c.payload.fileName,
    filePath: c.payload.filePath,
    chunkIndex: c.payload.chunkIndex,
    totalChunks: c.payload.totalChunks,
    pageNumber: c.payload.pageNumber,
    headingPath: c.payload.headingPath,
    text: c.payload.chunk,
    blockKind: c.payload.blockKind,
    tokenCount: c.payload.tokenCount,
  };
}

async function neighborChunks(
  filePath: string,
  chunkIndex: number,
  range: number
): Promise<AgentToolResult> {
  const clampedRange = Math.max(1, Math.min(range, NEIGHBOR_RANGE_MAX));
  const collected: ToolChunk[] = [];
  const seen = new Set<string>();

  for (let delta = -clampedRange; delta <= clampedRange; delta++) {
    if (delta === 0) continue;
    const target = chunkIndex + delta;
    if (target < 0) continue;
    const neighbors = await fetchByFilePathAndIndex(filePath, target);
    for (const n of neighbors) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      collected.push(toToolChunk(n));
    }
  }

  return { kind: 'chunks', chunks: collected, truncated: false };
}

async function sectionChunks(
  filePath: string,
  headingPath: string[]
): Promise<AgentToolResult> {
  const chunks = await fetchByFilePathAndHeadingPath(filePath, headingPath);
  return { kind: 'chunks', chunks: chunks.map(toToolChunk), truncated: false };
}

async function getChunkById(chunkId: string): Promise<AgentToolResult> {
  try {
    const points = (await qdrantClient.retrieve(QDRANT_COLLECTION, {
      ids: [chunkId],
      with_payload: true,
      with_vector: false,
    })) as Array<{
      id: string | number;
      payload?: Record<string, unknown> | null;
    }>;
    if (!points || points.length === 0) return notFound('Chunk not found');
    const collected: ToolChunk[] = [];
    for (const p of points) {
      const payload = (p.payload ?? {}) as unknown as DocumentChunk['payload'];
      collected.push({
        chunkId: String(p.id),
        fileName: payload.fileName,
        filePath: payload.filePath,
        chunkIndex: payload.chunkIndex,
        totalChunks: payload.totalChunks,
        pageNumber: payload.pageNumber,
        headingPath: payload.headingPath,
        text: payload.chunk,
        blockKind: payload.blockKind,
        tokenCount: payload.tokenCount,
      });
    }
    return { kind: 'chunks', chunks: collected, truncated: false };
  } catch (err) {
    log.warn({ err, chunkId }, 'get_chunk failed');
    return notFound('Chunk retrieve failed');
  }
}

async function getDocument(filePath: string, db: DB): Promise<AgentToolResult> {
  // The LLM sees filePath as the on-disk basename (fileId + ext).
  // Strip the trailing extension to recover the fileId.
  const fileId = filePath.replace(/\.[^.]+$/, '');
  if (!fileId) return notFound('Document not found');
  const doc = new DocumentStore(db).get(fileId);
  if (!doc) return notFound('Document not found');
  return { kind: 'document', document: doc };
}

/**
 * Dispatch an agent tool call. Pure function over (name, args, db) —
 * the agent loop and unit tests both call this directly. The db
 * parameter is required for `get_document`; pass the Fastify
 * singleton db to the loop and a `:memory:` db from tests.
 */
export async function executeAgentTool(
  name: AgentToolName,
  args: Record<string, unknown>,
  db: DB
): Promise<AgentToolResult> {
  switch (name) {
    case 'get_neighbor_chunks': {
      const filePath = args.filePath;
      const chunkIndex = args.chunkIndex;
      const range = typeof args.range === 'number' ? args.range : NEIGHBOR_RANGE_DEFAULT;
      if (typeof filePath !== 'string' || filePath === '') {
        return invalidArg('filePath (string) is required');
      }
      if (typeof chunkIndex !== 'number' || !Number.isFinite(chunkIndex) || chunkIndex < 0) {
        return invalidArg('chunkIndex (non-negative integer) is required');
      }
      if (typeof range !== 'number' || !Number.isFinite(range) || range < 1) {
        return invalidArg('range must be a positive integer');
      }
      return neighborChunks(filePath, chunkIndex, range);
    }

    case 'get_section_chunks': {
      const filePath = args.filePath;
      const headingPath = args.headingPath;
      if (typeof filePath !== 'string' || filePath === '') {
        return invalidArg('filePath (string) is required');
      }
      if (!Array.isArray(headingPath) || !headingPath.every((h) => typeof h === 'string')) {
        return invalidArg('headingPath (string[]) is required');
      }
      return sectionChunks(filePath, headingPath as string[]);
    }

    case 'get_chunk': {
      const chunkId = args.chunkId;
      if (typeof chunkId !== 'string' || chunkId === '') {
        return invalidArg('chunkId (string) is required');
      }
      return getChunkById(chunkId);
    }

    case 'get_document': {
      const filePath = args.filePath;
      if (typeof filePath !== 'string' || filePath === '') {
        return invalidArg('filePath (string) is required');
      }
      return getDocument(filePath, db);
    }
  }
}

// The four tool definitions exposed to the LLM. JSON Schema — stable
// across providers; tests assert the array length and required-field
// set so accidental renames are caught.
export const AGENT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_neighbor_chunks',
      description:
        'Fetch chunks immediately before and after a given chunk within the same document. ' +
        'Use to see what comes before or after a passage that looked relevant.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filePath: {
            type: 'string',
            description: 'Internal filePath (on-disk basename) of the document.',
          },
          chunkIndex: {
            type: 'integer',
            minimum: 0,
            description: 'Chunk index to center the window on.',
          },
          range: {
            type: 'integer',
            minimum: 1,
            maximum: NEIGHBOR_RANGE_MAX,
            description: `How many chunks on each side. Default 2, max ${NEIGHBOR_RANGE_MAX}.`,
          },
        },
        required: ['filePath', 'chunkIndex'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_section_chunks',
      description:
        'Fetch all chunks in the same heading section of a given document. ' +
        'Use to see the full context surrounding a passage.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filePath: {
            type: 'string',
            description: 'Internal filePath (on-disk basename) of the document.',
          },
          headingPath: {
            type: 'array',
            items: { type: 'string' },
            description: 'Heading path (e.g. ["Chapter 2", "Setup"]).',
          },
        },
        required: ['filePath', 'headingPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_chunk',
      description: 'Fetch a specific chunk by its ID. Use to drill into a specific passage.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chunkId: {
            type: 'string',
            description: 'Chunk ID returned by an earlier search or tool call.',
          },
        },
        required: ['chunkId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_document',
      description:
        'Fetch metadata for a document by its internal filePath. ' +
        'Use to discover what a document contains without re-running a search.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filePath: {
            type: 'string',
            description: 'Internal filePath (on-disk basename) of the document.',
          },
        },
        required: ['filePath'],
      },
    },
  },
];

// Stable, ordered list of tool names — used by the agent loop and
// the SSE event payload so the client knows which tools are in scope.
export const AGENT_TOOL_NAMES: AgentToolName[] = [
  'get_neighbor_chunks',
  'get_section_chunks',
  'get_chunk',
  'get_document',
];
