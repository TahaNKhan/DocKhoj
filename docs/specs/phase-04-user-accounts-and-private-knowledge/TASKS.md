# Phase 04 — Tasks

Task IDs use `p4-TNN`. Each task is one commit, testable in isolation. Status starts at `todo`; flip to `in-progress` when started, `done` when acceptance criteria are met.

Each task ends with: `./restart.sh` (clean rebuild + smoke) AND `npm test -- --run` passing, per project `CLAUDE.md` §3. No commit without both passing.

## T1. Branch + worktree + spec folder

- **Description.** Create the `phase/04-user-accounts-and-private-knowledge` branch from `main`, set up a worktree at `.claude/worktrees/phase-04-user-accounts-and-private-knowledge/`, and commit the spec folder into the branch.
- **Maps to requirements.** n/a (foundational).
- **Maps to design.** §"Isolation"; §"Implementation order" step 1.
- **Acceptance criteria.**
  - `git branch --show-current` reports `phase/04-user-accounts-and-private-knowledge`.
  - Worktree exists at the documented path.
  - Spec folder's `README.md`, `requirements.md`, `design.md`, `TASKS.md` are committed.
- **Dependencies.** none.
- **Estimate.** S.
- **Status.** done.

## T2. Schema migrations (users + auth_sessions + invites + documents columns)

- **Description.** Write and verify migration files. Apply against a fresh volume to verify.
  - `005_users.sql` — `users`, `auth_sessions`, `invites` tables per `design.md` §"Data model".
  - `006_documents_owner.sql` — `ALTER TABLE documents ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;`; `ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private'));`. Legacy rows get the default (`NULL`, `'public'`).
- **Maps to requirements.** FR-26; FR-1/2/3 (table shape).
- **Maps to design.** §"Data model"; §"Implementation order" step 2.
- **Acceptance criteria.**
  - Migration runner reports `applied: 2` on a fresh volume and `applied: 0` on a re-run (idempotency).
  - `sqlite3 conversations.db ".schema users"` shows the expected columns + FKs.
  - `sqlite3 conversations.db "SELECT file_id, owner_id, visibility FROM documents LIMIT 5;"` returns rows with `owner_id = NULL, visibility = 'public'` for any pre-existing data.
- **Dependencies.** T1.
- **Estimate.** S.
- **Status.** done.

## T3. Qdrant payload backfill + new payload indexes

- **Description.** Extend `services/qdrant.ts`:
  - Add `setOwnerVisibility(fileId, ownerId, visibility)` that updates the Qdrant point payloads for all chunks of a given file with `ownerId` and `visibility`. Existing primitive rewritten to use Qdrant's `set_payload` API.
  - Extend `ensurePayloadIndexes()` to add `keyword` indexes for `ownerId` and `visibility`.
  - Add a one-shot `migratePayloads()` function that scans every point in the collection and sets `ownerId = null, visibility = 'public'` when those fields are missing. Idempotent (skips points that already have both fields). Called from `start()` in `index.ts` after `initCollection()`. Guarded by a per-collection "already migrated" flag stored in a small `app_metadata` collection (key: `phase_04_qdrant_migration_applied`, value: timestamp).
- **Maps to requirements.** FR-29/31/33; FR-15/16.
- **Maps to design.** §"Data model" (Qdrant); §"Implementation order" step 3.
- **Acceptance criteria.**
  - On a Phase-03-era Qdrant volume: `migratePayloads()` updates every point; subsequent calls are no-ops.
  - `ensurePayloadIndexes()` reports the two new indexes as created (or "already exists" on re-run).
  - A test uploads a file pre-migration, runs the migration, asserts the chunk payload now has both fields.
- **Dependencies.** T2.
- **Estimate.** M.
- **Status.** done.

## T4. UserStore + AuthSessionStore + InviteStore + password.ts

- **Description.** Write the four service modules + vitest unit tests.
  - `password.ts` — `hashPassword(plain): Promise<string>` and `verifyPassword(plain, hash): Promise<boolean>`. Uses Node stdlib `crypto.scrypt` (N=2^14, r=8, p=1, 16-byte salt, 64-byte derived key). Hash format string carries the algorithm prefix (`scrypt$N$r$p$saltB64$derivedB64`) so a future migration to argon2id is a verify-path swap with no schema change.
  - `user-store.ts` — `createUser({username, password, role}): Promise<User>`, `findByUsername(username)`, `findById(id)`, `updateLastLogin(id)`, `listAll()`, `deleteById(id)`, `updatePasswordHash(id, hash)`, `usernameExists(username)`. Username validation (`^[A-Za-z0-9_-]{3,32}$`) lives here.
  - `auth-session-store.ts` — `create(userId)`, `findById(id)` (returns null if `expires_at < now`), `touch(id)` (updates `last_seen_at` + `expires_at`), `deleteById(id)`, `deleteByUser(userId)`.
  - `invite-store.ts` — `create({createdBy, expiresInDays?})` returns `{id, token, expiresAt}` (token = 32-byte random b64url; only the SHA-256 hash stored), `findByRawToken(rawToken)`, `markUsed(id, userId)`, `listOutstanding()`, `deleteById(id)`.
- **Maps to requirements.** FR-1..14; FR-15..19 (table semantics).
- **Maps to design.** §"Data model"; §"Key algorithms / flows".
- **Acceptance criteria.**
  - `npm test -- --run tests/services/user-store.test.ts tests/services/auth-session-store.test.ts tests/services/invite-store.test.ts tests/services/password.test.ts` all pass.
  - A unit test asserts `findByRawToken` returns the row whose `token_hash` matches the SHA-256 of the input.
  - A unit test asserts `touch()` advances `expires_at` by exactly 30 days from `now()` within a 1-second tolerance.
  - A unit test asserts username validation rejects `"ab"` (too short), `"hello world"` (space), and accepts `"alice-42"`.
- **Dependencies.** T2.
- **Estimate.** M.
- **Status.** done.

## T5. Auth Fastify plugin (middleware) + mount in index.ts

- **Description.** Write `services/auth.ts` exporting a Fastify plugin that:
  - Registers the session lookup on `onRequest`.
  - Decorates `fastify` with `request.user` typing via `declare module 'fastify' { interface FastifyRequest { user?: { id, username, role } } }`.
  - Publicly exempts `/api/auth/*` and `/api/health`.
  - On valid session: touches the session row + populates `request.user`.
  - On missing/expired session: returns `401` with `{ error: "Authentication required" }`.
  - Mounted in `index.ts` BEFORE every existing route plugin.
- **Maps to requirements.** FR-20/21/22/23/24/25; NFR-2.
- **Maps to design.** §"Architecture overview" (middleware); §"Key algorithms / flows → Authenticated request".
- **Acceptance criteria.**
  - `curl -i http://localhost:3001/api/chat -X POST -d '{}'` returns 401 JSON (no session).
  - `curl -i http://localhost:3001/api/health` returns 200 JSON (unauthenticated).
  - A vitest integration test asserts that a request with a malformed cookie gets 401, with a real session cookie gets `request.user` populated, and the `last_seen_at` is updated.
- **Dependencies.** T4.
- **Estimate.** M.
- **Status.** done.

## T6. /api/auth/* routes

- **Description.** Write `routes/api-auth.ts` with:
  - `POST /api/auth/register` — FR-1 (first user only; returns 403 if users exist).
  - `POST /api/auth/login` — FR-4/5.
  - `POST /api/auth/logout` — FR-6.
  - `GET /api/auth/me` — FR-7.
  - `GET /api/auth/status` — `{ firstUserAvailable: <users table empty?> }`.
  - `POST /api/auth/invite/accept` — FR-13/14.
  - All routes set / clear the `dockhoj_sid` cookie per NFR-2.
- **Maps to requirements.** FR-1..14.
- **Maps to design.** §"API surface".
- **Acceptance criteria.**
  - `curl -i -X POST http://localhost:3001/api/auth/register -H 'Content-Type: application/json' -d '{"username":"alice","password":"correcthorse123!"}'` returns 200 + Set-Cookie on a fresh volume.
  - Second register call returns 403.
  - `curl -X POST /api/auth/login` with bad password returns 401; with good password returns 200 + cookie.
  - `curl /api/auth/me` with cookie returns the user; without returns 401.
  - `curl /api/auth/status` returns `{ firstUserAvailable: false }` after the first user exists.
  - Vitest tests for each.
- **Dependencies.** T5.
- **Estimate.** M.
- **Status.** done.

## T7. /api/admin/* routes

- **Description.** Write `routes/api-admin.ts` with:
  - `POST /api/admin/invites` — FR-10.
  - `GET /api/admin/invites` — FR-11.
  - `DELETE /api/admin/invites/:id` — FR-12.
  - `GET /api/admin/users` — FR-15.
  - `DELETE /api/admin/users/:id` — FR-16 (with cascading delete of the user's documents + their auth sessions; their public-marked files become shared).
  - `POST /api/admin/users/:id/password` — FR-17 (also deletes that user's auth sessions).
  - Each handler checks `request.user.role === 'admin'`; else 403.
- **Maps to requirements.** FR-10..19.
- **Maps to design.** §"API surface".
- **Acceptance criteria.**
  - All non-admin access returns 403.
  - `POST /api/admin/users/<self>/password` works (admin can change their own password).
  - `DELETE /api/admin/users/<self>` returns 400.
  - After `DELETE /api/admin/users/:id`, the user's documents are gone (private) or have `owner_id = NULL` (formerly public), and all of their auth sessions are deleted (verified with `SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?;`).
  - Vitest tests for each.
- **Dependencies.** T5, T6.
- **Estimate.** M.
- **Status.** done.

## T8. buildVisibilityFilter + Qdrant integration

- **Description.** Update `services/qdrant.ts`:
  - Add `buildVisibilityFilter(viewerId: string): QdrantFilter` per design.
  - Thread `viewerId` through every public function that touches Qdrant for the requester: `searchChunks`, `expandHits`, `fetchByFilePathAndIndex`, `fetchByFilePathAndHeadingPath`. Update internal `_fetchByFilePathAndIndex` / `_fetchByFilePathAndHeadingPath` to accept a viewerId and merge.
  - `deleteByFilePath` does NOT take viewerId — the route handler does the explicit ownership check (per design §"Visibility filter").
- **Maps to requirements.** FR-32/33.
- **Maps to design.** §"Key algorithms / flows → Visibility filter".
- **Acceptance criteria.**
  - A vitest test: as user A, search returns chunks from A's own files + from public files, but never from B's private files.
- **Dependencies.** T3.
- **Estimate.** M.
- **Status.** done.

## T9. DocumentStore update + upload accepts visibility

- **Description.**
  - Update `services/document-store.ts` to read/write `owner_id` + `visibility` columns.
  - Update `routes/upload.ts`:
    - Accept `visibility` form field. Default `private`. Reject anything else with 400.
    - Stamp `owner_id = request.user.id`.
    - When upserting Qdrant chunks, set `ownerId` + `visibility` on each chunk's payload (using `setOwnerVisibility` after the batch upsert, per `services/qdrant.ts`).
    - Response gains `ownerUsername` + `visibility`.
- **Maps to requirements.** FR-27/28/29/30.
- **Maps to design.** §"API surface → upload"; §"Key algorithms / flows → Upload with visibility".
- **Acceptance criteria.**
  - `curl -b cookie -X POST /api/upload -F file=@foo.pdf -F visibility=private` succeeds; the SQLite row has `owner_id = request.user.id, visibility = 'private'`; the Qdrant chunk payloads have `ownerId` + `visibility = 'private'`.
  - Omitting the `visibility` form field defaults to `private`.
  - Sending `visibility=foo` returns 400.
- **Dependencies.** T8.
- **Estimate.** M.
- **Status.** done.

## T10. Documents endpoints + download scoped

- **Description.**
  - `GET /api/documents`: returns union of `owner_id = request.user.id OR owner_id IS NULL`. Response shape: each document carries `ownerUsername` + `visibility`.
  - `DELETE /api/documents/:fileId`: succeeds if `owner_id = request.user.id OR owner_id IS NULL`. Else 404 (per FR-35).
  - `GET /api/download/:filename`: load the documents row; check `owner_id = request.user.id OR owner_id IS NULL`. Else 404.
- **Maps to requirements.** FR-34/35/36.
- **Maps to design.** §"API surface".
- **Acceptance criteria.**
  - User A's private file does not appear in user B's document list (and vice versa).
  - Shared files (legacy `owner_id = NULL`) appear in both lists.
  - A's attempt to delete B's private file returns 404.
  - A can delete B's shared file.
  - A's attempt to download B's private file returns 404.
  - Vitest tests for each.
- **Dependencies.** T9.
- **Estimate.** M.
- **Status.** done.

## T11. Search + chat visibility

- **Description.** Thread `request.user.id` as `viewerId` into:
  - `routes/search.ts` (both `/api/search` and `/api/search/rag`).
  - `routes/chat.ts` (`/api/chat`).
  - `routes/chat-stream.ts` (`/api/chat/stream` — both the non-agentic fast path and the agent loop's expand-hits calls).
- **Maps to requirements.** FR-38.
- **Maps to design.** §"Key algorithms / flows".
- **Acceptance criteria.**
  - A test confirms that as user B, a search for terms that uniquely appear in user A's private file returns zero hits.
  - A test confirms that as user B, the same search returns hits after user A flips the file to public.
  - The chat-stream test uses a real SSE consumer and asserts no chunks from the private file leak via the `sources` event.
- **Dependencies.** T10.
- **Estimate.** M.
- **Status.** done.

## T12. Agent tools visibility

- **Description.** Update `services/agent-tools.ts` so that all four tools (`get_neighbor_chunks`, `get_section_chunks`, `get_chunk`, `get_document`) thread the viewer's id through to the Qdrant fetches and to the documents-row lookup in `get_document`. Foreign fileIds return an empty / "not found" response.
- **Maps to requirements.** FR-39.
- **Maps to design.** §"Architecture overview" (agent tools); §"Key algorithms / flows → Agent tool: get_document with a foreign fileId".
- **Acceptance criteria.**
  - During an `expand=auto` chat, the LLM is given a tool call where `fileId` is for a foreign private file; the tool returns `{ found: false }` (or equivalent empty shape), and the agent continues without leaking the chunks.
  - Vitest: simulate the agent-loop running one tool call per type against a foreign fileId and verify the result is opaque.
- **Dependencies.** T11.
- **Estimate.** M.
- **Status.** todo.

## T13. Cross-user retrieval integration test

- **Description.** Add an integration test (using `fastify.inject` against a real Fastify app wired to a real Qdrant + Ollama in the dev container) that:
  1. Registers user A (first).
  2. Logs in as A.
  3. Uploads a private file with distinctive content.
  4. Logs in as a fresh second session (or registers user B if A created an invite).
  5. Queries `/api/search` and `/api/chat` for terms unique to A's private file. Asserts zero hits.
  6. Repeats with the file flipped to public. Asserts hits.
  7. Asserts `deleteByFilePath` from B against A's private file returns 0 (because B can't see the file in the first place — the filter blocks the lookup).
- **Maps to requirements.** FR-40.
- **Maps to design.** §"Testing strategy".
- **Acceptance criteria.**
  - `npm test -- --run tests/e2e/cross-user-retrieval.test.ts` passes.
- **Dependencies.** T11, T12.
- **Estimate.** L.
- **Status.** todo.

## T14. Migration 006 (chat sessions ownership + delete legacy) + conversation scoping

- **Description.**
  - Write `007_chat_sessions_owner.sql`:
    - `ALTER TABLE conversations ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;`
    - `DELETE FROM conversations;` (cascades to `messages`).
  - Update `services/conversations.ts` to write/read `owner_id`.
  - Update `routes/api-sessions.ts`:
    - `POST /api/sessions` stamps `owner_id = request.user.id`.
    - `GET /api/sessions` returns only the current user's sessions.
    - All other session routes return 404 for sessions owned by another user.
- **Maps to requirements.** FR-41..45.
- **Maps to design.** §"Data model"; §"API surface".
- **Acceptance criteria.**
  - On a Phase-03-era SQLite: migration runs, `SELECT COUNT(*) FROM conversations;` returns 0, `SELECT COUNT(*) FROM messages;` returns 0.
  - User A's session is invisible to user B (verified via vitest).
  - User A's session list grows when they create new conversations; user B's doesn't.
- **Dependencies.** T10.
- **Estimate.** M.
- **Status.** done.

## T15. /api/status user-scoped

- **Description.** Update `routes/api-status.ts`: requires auth (per FR-20), returns `chunks` and `documents` counts scoped to `buildVisibilityFilter(request.user.id)` — i.e. only what the user can see. The TopBar status indicator now reflects the per-user view.
- **Maps to requirements.** FR-15 (modified)/20.
- **Maps to design.** §"API surface".
- **Acceptance criteria.**
  - Without a session, `/api/status` returns 401.
  - With a session, the `documents` count equals the number of files in the user's `/api/documents` list.
  - The `chunks` count reflects only chunks visible to the user.
  - Vitest covers both paths.
- **Dependencies.** T11.
- **Estimate.** S.
- **Status.** todo.

## T16. SPA: auth service + useAuth + Login/Register/InviteAccept + RouteGuard

- **Description.**
  - `web/src/services/auth.ts` — `fetchMe`, `login`, `logout`, `register`, `acceptInvite`, `fetchStatus`. Uses `fetch` with `credentials: 'include'`.
  - `web/src/hooks/useAuth.ts` — exposes `{ user, status }` from a context provider mounted in `App.tsx`. Initial state = loading; on mount calls `/api/auth/me`; on 401 sets `status = 'anonymous'`.
  - `web/src/components/RouteGuard.tsx` — `<RouteGuard requireRole="admin">…</RouteGuard>` wrapper. If `status === 'loading'`, render a spinner. If `status === 'anonymous'`, redirect to `/login?next=<current path>`. If `requireRole="admin"` and `user.role !== 'admin'`, render a 403 page.
  - `web/src/routes/Login.tsx`, `Register.tsx`, `InviteAccept.tsx`.
  - Wire the routes in the existing SPA entry. Initial route on `/` checks `/api/auth/me` and redirects: authenticated → `/chat`; anonymous + first user available → `/register`; else → `/login`.
- **Maps to requirements.** FR-24/25/46/47/51.
- **Maps to design.** §"Architecture overview"; §"API surface → SPA routes".
- **Acceptance criteria.**
  - `curl -i http://localhost:3001/chat` (no cookie) returns 200 SPA HTML; the SPA renders and then redirects to `/login?next=/chat`.
  - Logging in via the SPA sets the cookie; navigating to `/chat` works.
  - Navigating to `/admin/users` as a non-admin user renders the 403 component.
  - Vitest component tests for `RouteGuard` (anonymous → redirect; admin → render; loading → spinner).
- **Dependencies.** T6.
- **Estimate.** L.
- **Status.** done.

## T17. SPA: UserMenu + top-bar logout + route-guard wiring

- **Description.** `web/src/components/UserMenu.tsx` — shows the current `username` in the TopBar; click opens a dropdown with Logout + (admin-only) Admin → Users, Admin → Invites. Wire it into the existing TopBar. Wire `RouteGuard` into the existing `/chat`, `/upload`, and the new `/admin/*` routes.
- **Maps to requirements.** FR-47/48.
- **Maps to design.** §"Architecture overview".
- **Acceptance criteria.**
  - Logout click clears the cookie (set via `credentials: 'include'` on `POST /api/auth/logout`) and redirects to `/login`.
  - Admin sees both Admin links; non-admin does not.
  - Unauthenticated visit to `/upload` redirects to `/login?next=/upload`.
- **Dependencies.** T16.
- **Estimate.** S.
- **Status.** todo.

## T18. SPA: VisibilityToggle on upload + DocumentsList owner column

- **Description.**
  - `web/src/components/VisibilityToggle.tsx` — a Public/Private radio. Default `private`.
  - Wire into the existing `Upload.tsx` upload form. Pass `visibility` to the multipart POST.
  - Update `DocumentsList.tsx`: add `Owner` column ("Shared" when `ownerUsername === null`; else the username) and a `Visibility` chip (Public / Private). Show the delete button iff the user can delete (mirror the server rule: own + shared).
- **Maps to requirements.** FR-49/50.
- **Maps to design.** §"API surface → upload".
- **Acceptance criteria.**
  - Uploading without specifying visibility defaults to private; the upload row in the documents list shows the "Private" chip.
  - Uploading with visibility=public shows the "Public" chip and the same file is visible to a second logged-in user.
  - Documents list shows the owner for each file ("Shared" for null-owner legacy files).
  - Component tests cover both chips and the owner rendering.
- **Dependencies.** T10.
- **Estimate.** M.
- **Status.** done.

## T19. SPA: AdminUsers + AdminInvites

- **Description.**
  - `web/src/routes/AdminUsers.tsx` — list users with role badges; reset-password modal (calls `POST /api/admin/users/:id/password`); delete button with confirmation (cannot delete self — disabled).
  - `web/src/routes/AdminInvites.tsx` — list outstanding invites (without the raw token); "New invite" form (calls `POST /api/admin/invites` and surfaces the one-time token in a copyable banner); revoke button.
  - Wire into SPA router under `/admin/users` and `/admin/invites`.
  - Wire into the TopBar user menu (admin only).
- **Maps to requirements.** FR-46 (admin pages).
- **Maps to design.** §"API surface → SPA routes".
- **Acceptance criteria.**
  - Admin can create an invite; the token is shown exactly once with a copy button.
  - Admin can list / revoke invites. A revoked invite no longer works (`POST /api/auth/invite/accept` returns 410).
  - Admin cannot delete themselves (button disabled; even if forced, the server returns 400).
  - Admin can reset a user's password; the user is logged out across all sessions.
  - Non-admin cannot reach these pages (RouteGuard + server 403).
  - Component tests.
- **Dependencies.** T7, T17.
- **Estimate.** M.
- **Status.** todo.

## T20. .env.example + README updates

- **Description.**
  - `.env.example` — add a comment block: "Phase 04 enables auth by default. To disable / run in dev mode without a UI password, use `NODE_ENV=development` and visit `/register` first."
  - `README.md` — add an "Authentication" section. Add the deployment HTTPS callout (cookie `Secure` flag). Add a "Behavior changes from Phase 03 → Phase 04" section noting:
    - All `/api/*` endpoints now require auth except `/api/health` and `/api/auth/*`.
    - Documents are now per-user; `GET /api/documents` only returns files the requester can see.
    - Search + chat results are scoped; a user cannot retrieve another user's private chunks.
    - Pre-Phase-04 documents become shared; pre-Phase-04 conversations are dropped on migration.
- **Maps to requirements.** NFR-2 (callout); FR-25.
- **Maps to design.** §"Deployment / runtime".
- **Acceptance criteria.**
  - README has the new section; `./restart.sh` boots cleanly after the doc changes (no code change in this task).
- **Dependencies.** T19.
- **Estimate.** S.
- **Status.** todo.

## T21. Final E2E walkthrough + commit

- **Description.** Run the full user-stories walkthrough from `requirements.md` against a fresh `./restart.sh` boot, using `curl` per the project's `CLAUDE.md` end-to-end testing protocol. Resolve any rough edges. Update `TASKS.md` to mark each task `done`. Final commit to the branch.
- **Maps to requirements.** All acceptance criteria.
- **Maps to design.** §"Testing strategy → E2E".
- **Acceptance criteria.**
  - All 12 acceptance criteria from `requirements.md` §"Acceptance criteria" pass.
  - `npm test -- --run` is green.
  - `./restart.sh` rebuild is green.
  - The branch is committed; no uncommitted work; commit messages reference the task IDs (e.g. `feat(phase-4): register + login routes (p4-T06)`).
- **Dependencies.** T20.
- **Estimate.** M.
- **Status.** todo.

## Dependency graph

| Task | Depends on | Blocks | Est | Layer |
|------|------------|--------|-----|-------|
| **T1** Branch + worktree | — | T2 | S | infra *(done)* |
| **T2** Migrations: users, auth_sessions, invites, documents columns | T1 | T3, T4 | S | data |
| **T3** Qdrant payload backfill + ownerId/visibility indexes | T2 | T8 | M | qdrant |
| **T4** UserStore + AuthSessionStore + InviteStore + password.ts | T2 | T5 | M | service |
| **T5** Auth Fastify plugin + mount | T4 | T6 | M | api |
| **T6** /api/auth/* routes | T5 | T7, T16 | M | api |
| **T7** /api/admin/* routes | T5, T6 | T19 | M | api |
| **T8** buildVisibilityFilter + thread viewerId through qdrant.ts | T3 | T9 | M | qdrant |
| **T9** DocumentStore + upload accepts visibility | T8 | T10 | M | api |
| **T10** /api/documents scoped + /api/download scoped | T9 | T11, T14, T18 | M | api |
| **T11** Search + chat thread viewerId (incl. expand-hits) | T10 | T12, T13, T15 | M | api |
| **T12** Agent tools (4 tools) apply visibility filter | T11 | T13 | M | service |
| **T13** Cross-user retrieval E2E test | T11, T12 | T21 | L | test |
| **T14** Migration 006 + conversations scoped | T10 | — | M | api |
| **T15** /api/status user-scoped | T11 | — | S | api |
| **T16** SPA: useAuth + Login/Register/InviteAccept + RouteGuard | T6 | T17 | L | spa |
| **T17** SPA: UserMenu + top-bar logout + RouteGuard wiring | T16 | T19 | S | spa |
| **T18** SPA: VisibilityToggle on upload + DocumentsList owner column | T10 | — | M | spa |
| **T19** SPA: AdminUsers + AdminInvites | T7, T17 | T20 | M | spa |
| **T20** .env.example + README updates | T19 | T21 | S | docs |
| **T21** Final E2E walkthrough + commit | T20 | — | M | e2e |

> T18 only formally depends on T10, but Upload.tsx and DocumentsList.tsx sit behind `RouteGuard` (T16/T17) in the SPA tree, so practically the SPA diff is drafted after T10 and integrated alongside T17.

## Parallel workgroups

Tasks with no inter-dependencies — safe to run concurrently after the listed gate. Diffs do not overlap on the listed files.

| Gate | Parallel tasks (no shared files) |
|------|----------------------------------|
| After **T2** | `T3` (`services/qdrant.ts`) ∥ `T4` (`services/{user,auth-session,invite}-store.ts` + `services/password.ts`) |
| After **T3 ∩ T6** | `T8` (qdrant viewerId) ∥ `T7` (admin routes) ∥ `T16` (SPA auth pages + hooks + RouteGuard) |
| After **T10** | `T11` (search/chat/chat-stream routes) ∥ `T14` (api-sessions + conversations store + migration 006) ∥ `T18` (SPA VisibilityToggle + DocumentsList) |
| After **T11** | `T12` (`services/agent-tools.ts`) ∥ `T15` (`routes/api-status.ts`) |
| After **T7 ∩ T17** | `T19` (AdminUsers + AdminInvites SPA) — unblocks T20 |
| After **T19** | `T20` → `T21` — terminal, no parallelism left |

T13 (cross-user E2E) blocks on T11+T12 and slots in right after T12 lands. T21 is the terminal gate; every acceptance criterion in `requirements.md §"Acceptance criteria"` runs through it.

## Critical paths

Two chains tie for longest; they fork at T2 and reconverge at T19.

- **Longest (10 tasks):** T1 → T2 → T4 → T5 → T6 → T16 → T17 → T19 → T20 → T21
- **Backfill chain (9 tasks):** T1 → T2 → T3 → T8 → T9 → T10 → T11 → T12 → T13

To compress wall-clock: as soon as T2 lands, spin **T3** (Qdrant-only diff) and **T4** (stores-only diff) concurrently — their diffs don't overlap (`services/qdrant.ts` vs the four new `services/*-store.ts` files plus `services/password.ts`). T8 can start the moment T3 is green, in parallel with the T4→T5→T6 chain — that gets the visibility filter shipped to Qdrant before any new `/api/*` route takes traffic, which is the load-bearing invariant.

---

## Notes
- Per global CLAUDE.md §3, no commit without `./restart.sh` + `npm test -- --run` passing.
- Per global CLAUDE.md §0, no shortcuts — every task does the full feature; no `TODO` placeholders; the migration runner handles the legacy `DELETE FROM conversations;` cleanly with the FK cascade.
- If a task turns out larger than estimated during implementation, split in this file rather than letting it sprawl.
