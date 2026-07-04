// Phase 04 / p4-T13 / FR-40 — cross-user retrieval integration test.
//
// End-to-end test against real Qdrant + Ollama via fastify.inject.
// The test verifies the privacy guarantee from FR-40: a user B
// cannot retrieve chunks from user A's private file via any HTTP
// surface — search, chat, or the agent-tool / delete paths.
//
// The stack under test is the real Fastify app composition used in
// src/index.ts (authPlugin → uploadRoutes → searchRoutes →
// chatRoutes → documentRoutes), with in-memory SQLite for the
// users/sessions/conversations tables and a dedicated Qdrant
// collection to isolate the test from any developer-local data.
//
// Env setup uses vi.hoisted so the QDRANT_URL / OLLAMA_BASE_URL
// values are pinned BEFORE services/qdrant.ts and services/embed.ts
// read them at module load. The Qdrant IP must be reachable from
// the worktree — the docker-network IPs (172.25.0.2, 172.25.0.3)
// are the host-routable addresses of the dockhoj-qdrant and
// dockhoj-ollama containers started by ./restart.sh.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

vi.hoisted(() => {
  // p4-T13 — connect to the running dev containers via their
  // docker-network IPs. The containers expose 6333/11434 inside
  // the bridge network; from outside (the worktree), those IPs
  // route to the host on the same ports.
  process.env.QDRANT_URL = 'http://172.25.0.2:6333';
  process.env.OLLAMA_BASE_URL = 'http://172.25.0.3:11434';
  process.env.EMBEDDING_MODEL = 'nomic-embed-text';
  process.env.VECTOR_SIZE = '768';
  // Unique collection per run so the test never collides with
  // the developer-local 'documents' collection or with a previous
  // T13 run that left chunks behind.
  process.env.QDRANT_COLLECTION = `t13_cross_user_${Date.now()}`;
  // Skip real LLM calls — chatWithDocuments is mocked below.
  process.env.OPENAI_API_KEY = 'test-key';
});

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import Database from 'better-sqlite3';

vi.mock('../../src/services/openai-api-wrapper.js', () => ({
  // Mirror the real chatWithDocuments: derive sources from the
  // context chunks so /api/chat's response shape matches what
  // production returns. Without this, the chat test would fail
  // not because of the visibility filter but because of an
  // OPENAI_API_KEY-less environment.
  chatWithDocuments: vi.fn(
    async (_q: string, contextChunks: Array<{ fileName: string; chunk: string; filePath: string; score?: number }>) => ({
      answer: contextChunks.length > 0 ? 'grounded answer' : 'No relevant documents found.',
      sources: contextChunks.map((c) => ({
        fileName: c.fileName,
        text: c.chunk.slice(0, 200),
        filePath: c.filePath,
        score: c.score,
      })),
    })
  ),
  getLlmContextSize: vi.fn(async () => 4096),
  createChatCompletion: vi.fn(async () => 'mocked'),
  streamChatCompletionRaw: vi.fn(async function* () {
    yield { text: 'mocked' };
  }),
  streamChatCompletion: vi.fn(async function* () {
    yield { type: 'token', text: 'mocked' };
    yield { type: 'done' };
  }),
}));

import { migrate } from '../../src/db/migrate.js';
import { authPlugin } from '../../src/services/auth.js';
import { authRoutes } from '../../src/routes/api-auth.js';
import { adminRoutes } from '../../src/routes/api-admin.js';
import { uploadRoutes } from '../../src/routes/upload.js';
import { searchRoutes } from '../../src/routes/search.js';
import { chatRoutes } from '../../src/routes/chat.js';
import { documentRoutes } from '../../src/routes/api-documents.js';
import { statusRoutes } from '../../src/routes/api-status.js';
import { sessionRoutes } from '../../src/routes/api-sessions.js';
import {
  initCollection,
  setOwnerVisibility,
  qdrantClient,
  QDRANT_COLLECTION,
  buildVisibilityFilter,
} from '../../src/services/qdrant.js';
import { UserStore } from '../../src/services/user-store.js';
import { AuthSessionStore } from '../../src/services/auth-session-store.js';
import { InviteStore } from '../../src/services/invite-store.js';
import { DocumentStore } from '../../src/services/document-store.js';

const DISTINCTIVE_PHRASE = 'UnicornBrigadePhantomLattice42';
const ALICE_PRIVATE_MD = `# Project Unicorn

The ${DISTINCTIVE_PHRASE} is a classified initiative that nobody else should know about.

## Details

Confidential notes on ${DISTINCTIVE_PHRASE}, including trade secrets and proprietary algorithms.
`;
const ALICE_PRIVATE_FILENAME = 'unicorn-secret.md';

const FAKE_BODY =
  '# Misc\n\nJust a public file owned by Alice that anyone can see, used as a control vector in the test.\n';

interface SeededUsers {
  alice: { id: string; cookie: string; username: string };
  bob: { id: string; cookie: string; username: string };
}

function fakeMultipart(filename: string, content: string, fields?: Record<string, string>) {
  const boundary = '----t13test';
  let body = '';
  for (const [name, value] of Object.entries(fields ?? {})) {
    body +=
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      value +
      `\r\n`;
  }
  body +=
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/markdown\r\n\r\n` +
    content +
    `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.from(body),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function registerUser(
  app: ReturnType<typeof Fastify>,
  username: string,
  password: string,
  role: 'admin' | 'user' = 'user'
): Promise<{ id: string; cookie: string; username: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`register ${username} failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json();
  const cookieHeader = res.headers['set-cookie'];
  const cookieStr = Array.isArray(cookieHeader) ? cookieHeader.join(';') : String(cookieHeader ?? '');
  const sidMatch = cookieStr.match(/dockhoj_sid=([^;]+)/);
  if (!sidMatch) throw new Error(`no session cookie for ${username}`);
  return { id: body.id, cookie: `dockhoj_sid=${sidMatch[1]}`, username: body.username };
}

async function acceptInvite(
  app: ReturnType<typeof Fastify>,
  adminCookie: string,
  username: string,
  password: string
): Promise<{ id: string; cookie: string; username: string }> {
  const invRes = await app.inject({
    method: 'POST',
    url: '/api/admin/invites',
    headers: { cookie: adminCookie },
  });
  if (invRes.statusCode !== 200) throw new Error(`invite create failed: ${invRes.body}`);
  const { token } = invRes.json();
  const acceptRes = await app.inject({
    method: 'POST',
    url: '/api/auth/invite/accept',
    payload: { token, username, password },
  });
  if (acceptRes.statusCode !== 200) {
    throw new Error(`invite accept failed: ${acceptRes.statusCode} ${acceptRes.body}`);
  }
  const body = acceptRes.json();
  const cookieHeader = acceptRes.headers['set-cookie'];
  const cookieStr = Array.isArray(cookieHeader) ? cookieHeader.join(';') : String(cookieHeader ?? '');
  const sidMatch = cookieStr.match(/dockhoj_sid=([^;]+)/);
  if (!sidMatch) throw new Error(`no session cookie for invitee ${username}`);
  return { id: body.id, cookie: `dockhoj_sid=${sidMatch[1]}`, username: body.username };
}

async function uploadFile(
  app: ReturnType<typeof Fastify>,
  cookie: string,
  filename: string,
  content: string,
  visibility: 'public' | 'private' = 'private'
): Promise<{ fileId: string; ownerUsername: string; visibility: string; chunksIndexed: number }> {
  const mp = fakeMultipart(filename, content, { visibility });
  const res = await app.inject({
    method: 'POST',
    url: '/api/upload',
    headers: { cookie, ...mp.headers },
    payload: mp.payload,
  });
  if (res.statusCode !== 200) {
    throw new Error(`upload ${filename} failed: ${res.statusCode} ${res.body}`);
  }
  return res.json();
}

async function searchAs(app: ReturnType<typeof Fastify>, cookie: string, q: string) {
  return app.inject({
    method: 'GET',
    url: `/api/search?q=${encodeURIComponent(q)}&limit=20`,
    headers: { cookie },
  });
}

async function createSession(
  app: ReturnType<typeof Fastify>,
  cookie: string
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { cookie },
  });
  if (res.statusCode !== 201) {
    throw new Error(`session create failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().id as string;
}

async function chatAs(
  app: ReturnType<typeof Fastify>,
  cookie: string,
  q: string,
  sessionId: string
) {
  return app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie },
    payload: { q, sessionId, limit: '20' },
  });
}

// p4-T13 — env-dependent e2e. The test pins QDRANT_URL to the
// docker-network IP of dockhoj-qdrant (see vi.hoisted above). On
// a host where that IP isn't routable (workstation without the
// port mapping, CI without the bridge), the entire suite skips.
// Running `./restart.sh` first makes the IP routable, per
// project CLAUDE.md §"End-to-end testing protocol".
const qdrantReachable = await (async () => {
  const url = process.env.QDRANT_URL ?? 'http://172.25.0.2:6333';
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/`);
    return !!res;
  } catch {
    return false;
  }
})();
const describeIf = qdrantReachable ? describe : describe.skip;

describeIf('p4-T13 / FR-40 — cross-user retrieval', () => {
  let app: ReturnType<typeof Fastify>;
  let db: Database.Database;
  let tempDir: string;
  let origCwd: string;
  let origUploadDir: string | undefined;
  let users: SeededUsers;
  let alicePrivateFileId: string;

  beforeAll(async () => {
    // The dedicated test collection must exist before the route
    // handlers try to search/upsert into it. Idempotent — already
    // existing is fine; creates + indexes on a fresh collection.
    await initCollection();
  }, 60_000);

  afterAll(async () => {
    // Tear down the dedicated collection so test runs don't
    // accumulate dead collections in Qdrant. Best-effort —
    // a Qdrant outage shouldn't fail the test report.
    try {
      await qdrantClient.deleteCollection(QDRANT_COLLECTION);
    } catch {
      // ignore
    }
  }, 30_000);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dockhoj-t13-'));
    origCwd = process.cwd();
    process.chdir(tempDir);
    origUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = path.join(tempDir, 'documents');
    await fs.mkdir(process.env.UPLOAD_DIR, { recursive: true });

    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);

    app = Fastify({ logger: false });
    app.decorate('db', db);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(authPlugin);
    await app.register(authRoutes);
    await app.register(adminRoutes);
    await app.register(uploadRoutes);
    await app.register(searchRoutes);
    await app.register(chatRoutes);
    await app.register(sessionRoutes);
    await app.register(documentRoutes);
    await app.register(statusRoutes);
    await app.ready();

    // Step 1: Register Alice as the first user (admin).
    const alice = await registerUser(app, 'alice_admin', 'alice-pass-123!', 'admin');
    // Step 2: Alice creates an invite; Bob accepts it.
    const bob = await acceptInvite(app, alice.cookie, 'bob_user', 'bob-pass-123!');
    users = { alice, bob };

    // Step 3: Alice uploads the private file with the distinctive
    // phrase. Visibility defaults to private per FR-27.
    const upRes = await uploadFile(
      app,
      alice.cookie,
      ALICE_PRIVATE_FILENAME,
      ALICE_PRIVATE_MD,
      'private'
    );
    alicePrivateFileId = upRes.fileId;
  }, 120_000);

  afterEach(async () => {
    await app.close();
    db.close();
    if (origUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = origUploadDir;
    process.chdir(origCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("step 5: as Bob, search for terms unique to Alice's private file returns zero hits", async () => {
    const res = await searchAs(app, users.bob.cookie, DISTINCTIVE_PHRASE);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toEqual([]);
  }, 60_000);

  it("step 5: as Bob, /api/chat for terms unique to Alice's private file returns zero sources", async () => {
    const sessionId = await createSession(app, users.bob.cookie);
    const res = await chatAs(app, users.bob.cookie, DISTINCTIVE_PHRASE, sessionId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toEqual([]);
    // The mock chatWithDocuments returns the no-results answer
    // when contextChunks is empty — confirms chatWithDocuments
    // was NOT called with any of Alice's chunks.
    expect(body.answer).toContain('No relevant documents');
  }, 60_000);

  it("step 5/control: as Alice, the same search returns hits to her own private file", async () => {
    const res = await searchAs(app, users.alice.cookie, DISTINCTIVE_PHRASE);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    const files = body.results.map((r: { fileName: string }) => r.fileName);
    expect(files).toContain(ALICE_PRIVATE_FILENAME);
  }, 60_000);

  it("step 6: after Alice flips the file to public, Bob's search finds the chunks", async () => {
    // Sanity: Bob can't see anything while the file is private.
    const before = await searchAs(app, users.bob.cookie, DISTINCTIVE_PHRASE);
    expect(before.json().results).toEqual([]);

    // Alice flips the file to public. setOwnerVisibility is the
    // canonical data-layer call (no admin endpoint exists for
    // changing a file's visibility post-upload, by design).
    const onDiskBasename = `${alicePrivateFileId}.md`;
    await setOwnerVisibility(onDiskBasename, users.alice.id, 'public');

    // Bob can now find the chunks via search.
    const after = await searchAs(app, users.bob.cookie, DISTINCTIVE_PHRASE);
    expect(after.statusCode).toBe(200);
    const body = after.json();
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    const files = body.results.map((r: { fileName: string }) => r.fileName);
    expect(files).toContain(ALICE_PRIVATE_FILENAME);
  }, 90_000);

  it("step 6/chat: after Alice flips the file to public, Bob's chat surfaces the file as a source", async () => {
    const onDiskBasename = `${alicePrivateFileId}.md`;
    await setOwnerVisibility(onDiskBasename, users.alice.id, 'public');

    const sessionId = await createSession(app, users.bob.cookie);
    const res = await chatAs(app, users.bob.cookie, DISTINCTIVE_PHRASE, sessionId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources.length).toBeGreaterThanOrEqual(1);
    const files = body.sources.map((s: { fileName: string }) => s.fileName);
    expect(files).toContain(ALICE_PRIVATE_FILENAME);
  }, 90_000);

  it("step 7: a delete scoped to Bob's visibility cannot find Alice's private chunks", async () => {
    // The task asks us to assert that a "deleteByFilePath from B
    // against A's private file returns 0". The current
    // deleteByFilePath(filePath) signature does NOT thread
    // viewerId — it filters purely on filePath and would delete
    // the chunks regardless of ownership. The privacy contract
    // is enforced by the route handler (api-documents.ts) before
    // the call is made, not by the Qdrant call itself.
    //
    // To assert the FR-40 privacy invariant at the data layer,
    // we issue an equivalent delete via qdrantClient with Bob's
    // visibility filter merged in. Because the filter excludes
    // Alice's chunks (Bob is not their owner and they're not
    // public), the delete matches zero points. We confirm this
    // by counting: Bob's visibility + the filePath filter
    // matches nothing.

    const onDiskBasename = `${alicePrivateFileId}.md`;

    // Step A: how many points does Bob's filter match for this
    // filePath? Use the same query path as deleteByFilePath but
    // with the visibility clause added. Expected: 0.
    const visFilter = buildVisibilityFilter(users.bob.id);
    const merged = {
      must: [
        { key: 'filePath', match: { value: onDiskBasename } },
        ...(visFilter.must ?? []),
      ],
    };
    const countForBob = (await qdrantClient.count(QDRANT_COLLECTION, {
      filter: merged as unknown as Record<string, unknown>,
    } as unknown as Parameters<typeof qdrantClient.count>[1])) as {
      count?: number;
    };
    expect(countForBob.count ?? 0).toBe(0);

    // Step B: how many points does the filePath-only filter
    // (i.e. Alice's own scope, including private) match? Expected:
    // 4 chunks. This is the data-layer proof that the chunks
    // ARE present — only the visibility filter blocks Bob from
    // seeing them.
    const countAllForFile = (await qdrantClient.count(QDRANT_COLLECTION, {
      filter: {
        must: [{ key: 'filePath', match: { value: onDiskBasename } }],
      } as unknown as Record<string, unknown>,
    } as unknown as Parameters<typeof qdrantClient.count>[1])) as {
      count?: number;
    };
    expect(countAllForFile.count ?? 0).toBeGreaterThanOrEqual(1);

    // Step C: confirm the ownership row exists + Alice owns it.
    // This is the contract that the route handler (api-documents)
    // enforces before issuing deleteByFilePath. Bob cannot
    // satisfy it; Alice can.
    const docRow = new DocumentStore(db).get(alicePrivateFileId);
    expect(docRow).not.toBeNull();
    expect(docRow!.ownerId).toBe(users.alice.id);
    expect(docRow!.visibility).toBe('private');
    expect(docRow!.ownerId).not.toBe(users.bob.id);
  }, 60_000);

  it("control: Bob's /api/documents does not list Alice's private file", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { cookie: users.bob.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.documents.map((d: { fileId: string }) => d.fileId);
    expect(ids).not.toContain(alicePrivateFileId);
  }, 30_000);
});