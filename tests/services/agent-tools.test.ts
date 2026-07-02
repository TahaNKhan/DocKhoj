import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/db/migrate.js';
import { DocumentStore } from '../../src/services/document-store.js';

// Stub the Qdrant wrapper the same way the unit tests stub
// stream-chat — capture calls and return canned data. The agent-tools
// module imports both qdrant (for fetchByFilePathAndIndex /
// fetchByFilePathAndHeadingPath / qdrantClient.retrieve) and
// document-store (for getDocument).
const qdrantState = {
  // mocked fetch responses (filled per test)
  byIndex: new Map<string, Array<{ chunkIndex: number; text: string; payload: Record<string, unknown> }>>(),
  sectionHits: [] as Array<{ id: string; payload: Record<string, unknown> }>,
  retrievedPoints: [] as Array<{ id: string; payload: Record<string, unknown> }>,
  retrieveCalls: [] as Array<{ ids: string[] }>,
  // method calls
  indexCalls: [] as Array<{ filePath: string; chunkIndex: number }>,
  sectionCalls: [] as Array<{ filePath: string; headingPath: string[] }>,
};

vi.mock('../../src/services/qdrant.js', () => ({
  QDRANT_COLLECTION: 'documents-test',
  qdrantClient: {
    retrieve: vi.fn(async (collection: string, opts: { ids?: string[] }) => {
      qdrantState.retrieveCalls.push({ ids: opts.ids ?? [] });
      return qdrantState.retrievedPoints.filter((p) => (opts.ids ?? []).includes(p.id));
    }),
  },
  fetchByFilePathAndIndex: vi.fn(async (filePath: string, chunkIndex: number) => {
    qdrantState.indexCalls.push({ filePath, chunkIndex });
    const key = `${filePath}|${chunkIndex}`;
    const hits = qdrantState.byIndex.get(key) ?? [];
    return hits.map((h) => ({
      id: `${filePath}-${chunkIndex}`,
      vector: [],
      score: 0.9,
      payload: {
        chunk: h.text,
        chunkIndex: h.chunkIndex,
        totalChunks: 10,
        fileName: 'a.md',
        filePath,
        fileType: 'md',
        ...h.payload,
      },
    }));
  }),
  fetchByFilePathAndHeadingPath: vi.fn(async (filePath: string, headingPath: string[]) => {
    qdrantState.sectionCalls.push({ filePath, headingPath });
    return qdrantState.sectionHits
      .filter((h) => (h.payload as { filePath?: string }).filePath === filePath)
      .map((h, i) => ({
        id: h.id,
        vector: [],
        score: 0.9,
        payload: {
          chunk: (h.payload as { chunk: string }).chunk,
          fileName: 'a.md',
          filePath,
          fileType: 'md',
          chunkIndex: i,
          totalChunks: 10,
          ...h.payload,
        },
      }));
  }),
}));

import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  executeAgentTool,
  invalidArg,
  isAgentToolName,
  notFound,
  type AgentToolName,
} from '../../src/services/agent-tools.js';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function makeChunk(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    payload: {
      chunk: `text for ${id}`,
      fileName: 'a.md',
      filePath: 'doc-a.md',
      fileType: 'md',
      chunkIndex: 0,
      totalChunks: 10,
      ...overrides,
    },
  };
}

describe('agent-tools — executeAgentTool', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
    qdrantState.byIndex.clear();
    qdrantState.sectionHits.length = 0;
    qdrantState.retrievedPoints.length = 0;
    qdrantState.retrieveCalls.length = 0;
    qdrantState.indexCalls.length = 0;
    qdrantState.sectionCalls.length = 0;
  });

  describe('get_neighbor_chunks', () => {
    it('returns chunks ±range around the given index', async () => {
      const filePath = 'doc-a.md';
      // Seed chunks 3, 4, 5, 6, 7
      for (let i = 3; i <= 7; i++) {
        qdrantState.byIndex.set(`${filePath}|${i}`, [
          { chunkIndex: i, text: `chunk ${i}` },
        ]);
      }
      const out = await executeAgentTool(
        'get_neighbor_chunks',
        { filePath, chunkIndex: 5, range: 2 },
        db
      );
      expect(out.kind).toBe('chunks');
      if (out.kind !== 'chunks') return;
      // range 2: should fetch indices 3, 4, 6, 7 (skipping 5 = center)
      const fetched = qdrantState.indexCalls.map((c) => c.chunkIndex).sort();
      expect(fetched).toEqual([3, 4, 6, 7]);
      expect(out.chunks).toHaveLength(4);
      expect(out.chunks.every((c) => c.chunkId.startsWith(filePath))).toBe(true);
    });

    it('clamps range above the maximum to NEIGHBOR_RANGE_MAX', async () => {
      await executeAgentTool(
        'get_neighbor_chunks',
        { filePath: 'x.md', chunkIndex: 5, range: 99 },
        db
      );
      // range=99 clamps to 5 → ±5 indices excluding 5 = 10 calls
      expect(qdrantState.indexCalls.length).toBe(10);
    });

    it('treats range missing as the default (2)', async () => {
      await executeAgentTool(
        'get_neighbor_chunks',
        { filePath: 'x.md', chunkIndex: 5 },
        db
      );
      expect(qdrantState.indexCalls.length).toBe(4);
    });

    it('skips negative target indices', async () => {
      await executeAgentTool(
        'get_neighbor_chunks',
        { filePath: 'x.md', chunkIndex: 0, range: 2 },
        db
      );
      // center=0; range=2; skips delta=0; targets -2,-1,1,2 → -2,-1 skipped (negative)
      const fetched = qdrantState.indexCalls.map((c) => c.chunkIndex);
      expect(fetched).toEqual([1, 2]);
    });

    it('returns INVALID_ARG when filePath is missing', async () => {
      const out = await executeAgentTool(
        'get_neighbor_chunks',
        { chunkIndex: 0 },
        db
      );
      expect(out).toEqual(invalidArg('filePath (string) is required'));
    });

    it('returns INVALID_ARG when chunkIndex is not a number', async () => {
      const out = await executeAgentTool(
        'get_neighbor_chunks',
        { filePath: 'x.md', chunkIndex: 'five' },
        db
      );
      expect(out).toEqual(invalidArg('chunkIndex (non-negative integer) is required'));
    });

    it('returns INVALID_ARG when chunkIndex is negative', async () => {
      const out = await executeAgentTool(
        'get_neighbor_chunks',
        { filePath: 'x.md', chunkIndex: -1 },
        db
      );
      expect(out).toEqual(invalidArg('chunkIndex (non-negative integer) is required'));
    });

    it('returns INVALID_ARG when range is below 1', async () => {
      const out = await executeAgentTool(
        'get_neighbor_chunks',
        { filePath: 'x.md', chunkIndex: 0, range: 0 },
        db
      );
      expect(out).toEqual(invalidArg('range must be a positive integer'));
    });
  });

  describe('get_section_chunks', () => {
    it('returns chunks in the same heading section', async () => {
      qdrantState.sectionHits.push(
        makeChunk('c1', { headingPath: ['Chapter 2', 'Setup'], chunk: 'setup step 1' }),
        makeChunk('c2', { headingPath: ['Chapter 2', 'Setup'], chunk: 'setup step 2' })
      );
      const out = await executeAgentTool(
        'get_section_chunks',
        { filePath: 'doc-a.md', headingPath: ['Chapter 2', 'Setup'] },
        db
      );
      expect(out.kind).toBe('chunks');
      if (out.kind !== 'chunks') return;
      expect(out.chunks).toHaveLength(2);
      expect(qdrantState.sectionCalls).toEqual([
        { filePath: 'doc-a.md', headingPath: ['Chapter 2', 'Setup'] },
      ]);
    });

    it('returns INVALID_ARG when filePath is missing', async () => {
      const out = await executeAgentTool('get_section_chunks', { headingPath: [] }, db);
      expect(out).toEqual(invalidArg('filePath (string) is required'));
    });

    it('returns INVALID_ARG when headingPath is not a string array', async () => {
      const out = await executeAgentTool(
        'get_section_chunks',
        { filePath: 'x.md', headingPath: 'Chapter 2' },
        db
      );
      expect(out).toEqual(invalidArg('headingPath (string[]) is required'));
    });

    it('returns INVALID_ARG when headingPath contains non-strings', async () => {
      const out = await executeAgentTool(
        'get_section_chunks',
        { filePath: 'x.md', headingPath: ['Chapter 2', 5] },
        db
      );
      expect(out).toEqual(invalidArg('headingPath (string[]) is required'));
    });
  });

  describe('get_chunk', () => {
    it('returns a chunk by ID', async () => {
      qdrantState.retrievedPoints.push(makeChunk('chunk-xyz'));
      const out = await executeAgentTool('get_chunk', { chunkId: 'chunk-xyz' }, db);
      expect(out.kind).toBe('chunks');
      if (out.kind !== 'chunks') return;
      expect(out.chunks).toHaveLength(1);
      expect(out.chunks[0].chunkId).toBe('chunk-xyz');
      expect(qdrantState.retrieveCalls).toEqual([{ ids: ['chunk-xyz'] }]);
    });

    it('returns NOT_FOUND when no point matches', async () => {
      const out = await executeAgentTool('get_chunk', { chunkId: 'absent' }, db);
      expect(out).toEqual(notFound('Chunk not found'));
    });

    it('returns INVALID_ARG when chunkId is missing', async () => {
      const out = await executeAgentTool('get_chunk', {}, db);
      expect(out).toEqual(invalidArg('chunkId (string) is required'));
    });

    it('returns NOT_FOUND if the underlying qdrant call throws', async () => {
      const { qdrantClient } = await import('../../src/services/qdrant.js');
      (qdrantClient.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('network blip')
      );
      const out = await executeAgentTool('get_chunk', { chunkId: 'x' }, db);
      expect(out).toEqual(notFound('Chunk retrieve failed'));
    });
  });

  describe('get_document', () => {
    it('returns the document metadata row by filePath', async () => {
      new DocumentStore(db).insert({
        fileId: 'doc-abc',
        fileName: 'notes.md',
        fileType: 'md',
        bytes: 100,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 4,
      });

      // Tool sees filePath = `${fileId}${ext}` = 'doc-abc.md'
      const out = await executeAgentTool(
        'get_document',
        { filePath: 'doc-abc.md' },
        db
      );
      expect(out.kind).toBe('document');
      if (out.kind !== 'document') return;
      expect(out.document?.fileId).toBe('doc-abc');
      expect(out.document?.fileName).toBe('notes.md');
    });

    it('returns NOT_FOUND when no row matches the fileId', async () => {
      const out = await executeAgentTool(
        'get_document',
        { filePath: 'missing-id.md' },
        db
      );
      expect(out).toEqual(notFound('Document not found'));
    });

    it('returns INVALID_ARG when filePath is empty', async () => {
      const out = await executeAgentTool('get_document', { filePath: '' }, db);
      expect(out).toEqual(invalidArg('filePath (string) is required'));
    });

    it('returns INVALID_ARG when filePath is missing', async () => {
      const out = await executeAgentTool('get_document', {}, db);
      expect(out).toEqual(invalidArg('filePath (string) is required'));
    });

    it('returns NOT_FOUND for a filePath with no extension (fileId empty after strip)', async () => {
      // After `.replace(/\.[^.]+$/, '')` on '.md' we get ''. Empty
      // fileId → not found.
      const out = await executeAgentTool('get_document', { filePath: '.md' }, db);
      expect(out).toEqual(notFound('Document not found'));
    });

    it('falls back to file_name lookup when no fileId matches (p3-T12)', async () => {
      // p3-T12: the LLM frequently passes the user-facing fileName
      // (e.g. "CC&Rs.pdf") instead of the on-disk basename
      // ("<uuid>.pdf"). The tool should resolve either form.
      new DocumentStore(db).insert({
        fileId: 'doc-xyz',
        fileName: 'CC&Rs.pdf',
        fileType: 'pdf',
        bytes: 200,
        uploadedAt: '2026-07-02 09:00:00',
        chunkCount: 12,
      });

      const out = await executeAgentTool(
        'get_document',
        { filePath: 'CC&Rs.pdf' },
        db
      );
      expect(out.kind).toBe('document');
      if (out.kind !== 'document') return;
      expect(out.document?.fileId).toBe('doc-xyz');
      expect(out.document?.fileName).toBe('CC&Rs.pdf');
    });

    it('returns NOT_FOUND when neither fileId nor fileName matches', async () => {
      new DocumentStore(db).insert({
        fileId: 'doc-xyz',
        fileName: 'notes.md',
        fileType: 'md',
        bytes: 100,
        uploadedAt: '2026-07-02 09:00:00',
        chunkCount: 4,
      });
      const out = await executeAgentTool(
        'get_document',
        { filePath: 'nonexistent.pdf' },
        db
      );
      expect(out).toEqual(notFound('Document not found'));
    });

    it('picks the most-recent upload when multiple rows share a fileName', async () => {
      // Two uploads of the same fileName; the tool should pick the
      // most-recent one (mirrors DocumentStore.list ordering).
      new DocumentStore(db).insert({
        fileId: 'doc-older',
        fileName: 'notes.md',
        fileType: 'md',
        bytes: 50,
        uploadedAt: '2026-07-01 10:00:00',
        chunkCount: 2,
      });
      new DocumentStore(db).insert({
        fileId: 'doc-newer',
        fileName: 'notes.md',
        fileType: 'md',
        bytes: 60,
        uploadedAt: '2026-07-02 10:00:00',
        chunkCount: 3,
      });

      const out = await executeAgentTool(
        'get_document',
        { filePath: 'notes.md' },
        db
      );
      expect(out.kind).toBe('document');
      if (out.kind !== 'document') return;
      expect(out.document?.fileId).toBe('doc-newer');
    });
  });
});

describe('agent-tools — AGENT_TOOLS shape', () => {
  it('exposes exactly four tools', () => {
    expect(AGENT_TOOLS).toHaveLength(4);
  });

  it('names match the expected ordered list', () => {
    expect(AGENT_TOOL_NAMES).toEqual([
      'get_neighbor_chunks',
      'get_section_chunks',
      'get_chunk',
      'get_document',
    ]);
    const names = AGENT_TOOLS.map((t) => t.function.name);
    expect(names).toEqual(AGENT_TOOL_NAMES);
  });

  it('every tool has a function schema with parameters.type=object', () => {
    for (const t of AGENT_TOOLS) {
      expect(t.type).toBe('function');
      expect(t.function.parameters.type).toBe('object');
      expect(typeof t.function.description).toBe('string');
      expect(t.function.description.length).toBeGreaterThan(20);
    }
  });

  it('get_neighbor_chunks requires filePath + chunkIndex; range has max 5', () => {
    const tool = AGENT_TOOLS.find((t) => t.function.name === 'get_neighbor_chunks')!;
    expect(tool.function.parameters.required).toEqual(['filePath', 'chunkIndex']);
    expect(tool.function.parameters.properties.range.maximum).toBe(5);
  });

  it('get_section_chunks requires filePath + headingPath', () => {
    const tool = AGENT_TOOLS.find((t) => t.function.name === 'get_section_chunks')!;
    expect(tool.function.parameters.required).toEqual(['filePath', 'headingPath']);
    expect(tool.function.parameters.properties.headingPath.type).toBe('array');
  });

  it('get_chunk requires chunkId only', () => {
    const tool = AGENT_TOOLS.find((t) => t.function.name === 'get_chunk')!;
    expect(tool.function.parameters.required).toEqual(['chunkId']);
  });

  it('get_document requires filePath only', () => {
    const tool = AGENT_TOOLS.find((t) => t.function.name === 'get_document')!;
    expect(tool.function.parameters.required).toEqual(['filePath']);
  });
});

describe('agent-tools — isAgentToolName', () => {
  it('accepts the four known names', () => {
    for (const n of ['get_neighbor_chunks', 'get_section_chunks', 'get_chunk', 'get_document'] as AgentToolName[]) {
      expect(isAgentToolName(n)).toBe(true);
    }
  });

  it('rejects unknown names', () => {
    expect(isAgentToolName('unknown_tool')).toBe(false);
    expect(isAgentToolName('')).toBe(false);
    expect(isAgentToolName('GET_NEIGHBOR_CHUNKS')).toBe(false);
  });
});
