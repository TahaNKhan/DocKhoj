# Phase 04 — Requirements

## Purpose
DocKhoj is currently single-tenant: one process, one implicit user, all documents visible to all callers. Phase 04 turns it into a proper multi-user application. Each user gets an account, owns their own uploaded files, and can choose which of those files are public-to-all-logged-in-users or private-to-themselves. A user cannot retrieve, list, download, or chat-against another user's private files — that filter applies uniformly across every retrieval path, including the LLM tool surface inside the agentic-RAG loop.

The motivation is the deployment topology of self-hosted DocKhoj: once a server is reachable beyond localhost (a LAN address, a tunnel, a public domain), the lack of auth means anyone who can reach the URL can read every document and spend LLM tokens. Phase 04 makes that safe.

## Users / actors
- **Owner (first registrant).** On a fresh install, the very first person to hit `POST /api/auth/register` becomes the admin. They are the only person who can create accounts for everyone else.
- **Admin.** A user with `role = 'admin'`. Can invite new users, list users, delete users, reset another user's password. Can also do everything a regular user can.
- **Regular user.** A user with `role = 'user'`. Can upload files (private by default; can mark public), chat, list and delete their own files, list and delete shared files, and manage their own sessions.
- **Unauthenticated caller.** Has no `dockhoj_sid` cookie, or has one that doesn't resolve to a live session row. Can reach only `/api/health`, `/api/auth/login`, `/api/auth/register` (first user only), and `/api/auth/invite/accept`. Every other `/api/*` returns 401 JSON.
- **Docker healthcheck.** The container's HEALTHCHECK pings `/api/health` and must continue to do so — `/api/health` stays unauthenticated.

## User stories
1. **First-run setup.** Taha spins up DocKhoj for the first time. He visits `http://localhost:3001`, gets redirected to `/login`, clicks "Create the first account", picks a username and password, and is logged in. He is now the admin.
2. **Invite a teammate.** As admin, Taha clicks "Admin → Invites → New invite", gets a URL like `/register/abc123def`, copies it, and sends it to Alex. The link expires in 7 days.
3. **Accept an invite.** Alex clicks the link, lands on `/register/abc123def`, picks a username and password, and is logged in as a regular user.
4. **Upload a private file.** Alex uploads `taxes-2026.pdf` with visibility = Private. It shows up in his `/upload` page's document list, owned by `alex`, with a "Private" chip.
5. **Upload a public file.** Alex uploads `team-handbook.md` with visibility = Public. It shows up in his document list with a "Public" chip and also shows up in Taha's document list under the shared bucket.
6. **Cross-user privacy.** Alex asks the chatbot "what's in my taxes file?" and gets a real answer. Taha asks the chatbot the same question and gets "I couldn't find any relevant content in your documents." Taha cannot see `taxes-2026.pdf` in `/api/documents`, cannot pull it via `/api/download/:fileId`, cannot trigger retrieval of its chunks via any agent tool.
7. **Shared bucket deletion.** Taha (the admin) sees the public `team-handbook.md` in his documents list because it's shared. He clicks delete. The file is removed from Qdrant, from disk, and from the SQLite row — for everyone.
8. **Logout.** Alex clicks his username in the top bar → Logout. The cookie is cleared and the server-side session row is deleted. He is bounced to `/login`.
9. **Session expiry.** Alex's session cookie expires after 30 days of inactivity. On his next request, the server returns 401, the SPA bounces to `/login?next=/chat`, and he logs in again.
10. **Admin resets a password.** Alex forgets his password. Taha goes to Admin → Users → Alex → Reset Password, sets a new one, and tells Alex. Alex logs in with the new password on his next attempt.
11. **Admin removes a user.** Taha fires Alex. Admin → Users → Alex → Delete. Alex's user row, sessions, and private documents are all removed. Documents Alex had marked public (shared bucket) remain — they had no owner.
12. **Agent cannot exfiltrate.** During an agentic-RAG chat, the LLM is given the four retrieval tools. It calls `get_document` with a fileId belonging to one of Alex's private files. The tool returns "not found / not accessible". The LLM cannot reason its way around the server-side filter.

## Functional requirements

### A. Users & accounts
- **FR-1.** `POST /api/auth/register` creates a new user. Body: `{ username, password }`. If the `users` table is empty, the new user is created with `role = 'admin'`. Otherwise the endpoint returns 403 with `{ error: "Registration is invite-only" }`.
- **FR-2.** `username` is 3–32 characters, `[A-Za-z0-9_-]+`, case-sensitive, unique.
- **FR-3.** `password` is at least 12 characters, at least one non-alphanumeric character. Hashed with argon2id at OWASP-recommended parameters (memory cost ≥ 19 MiB, time cost ≥ 2, parallelism = 1).
- **FR-4.** `POST /api/auth/login` body: `{ username, password }`. On success: creates a row in `sessions` (id = 32-byte random URL-safe base64), sets `dockhoj_sid` cookie (HttpOnly, SameSite=Lax, Path=/, Max-Age=2592000), updates `users.last_login_at`, returns `{ id, username, role }`.
- **FR-5.** On login failure: returns 401 with `{ error: "Invalid username or password" }`. No distinction between bad-username and bad-password in the error message (no enumeration).
- **FR-6.** `POST /api/auth/logout` deletes the current session row (if any) and clears the cookie. Idempotent.
- **FR-7.** `GET /api/auth/me` returns `{ id, username, role }` for the current user, or 401 if no valid session.
- **FR-8.** Sessions expire 30 days after `last_seen_at`. On every authenticated request, the server updates `last_seen_at = now()` for the current session, extending the rolling expiry.
- **FR-9.** Sessions can be revoked by deleting the row (logout, admin "force logout", user deletion, expiry sweep).

### B. Invites
- **FR-10.** `POST /api/admin/invites` (admin only) creates an invite row. Body: `{ expiresInDays?: number }` (default 7). Returns `{ id, token, expiresAt }`. The `token` is a 32-byte URL-safe base64 random string; only the SHA-256 hash of the token is stored in the DB.
- **FR-11.** `GET /api/admin/invites` (admin only) lists outstanding (unused, unexpired) invites. Response excludes the token itself.
- **FR-12.** `DELETE /api/admin/invites/:id` (admin only) deletes the invite row. The token is dead immediately.
- **FR-13.** `POST /api/auth/invite/accept` body: `{ token, username, password }`. Validates the token (exists, unused, unexpired), validates the username + password (per FR-2 / FR-3), creates the user with `role = 'user'`, marks the invite `used_by = user.id, used_at = now()`, and establishes a session (sets the cookie + creates a sessions row).
- **FR-14.** Invite acceptance is single-use. Subsequent attempts with the same token return 410.

### C. Admin user management
- **FR-15.** `GET /api/admin/users` (admin only) returns `[{ id, username, role, createdAt, lastLoginAt }, ...]`. Never includes the password hash.
- **FR-16.** `DELETE /api/admin/users/:id` (admin only) deletes the user, all their sessions, and all their private documents (Qdrant chunks + on-disk files + SQLite rows). Documents with `owner_id = NULL` (shared) are not touched. Returns 400 if `id === request.user.id` (an admin cannot delete themselves).
- **FR-17.** `POST /api/admin/users/:id/password` (admin only) body: `{ password }` (validated per FR-3). Replaces the user's `password_hash`. The user must log in again on their next request (their existing session is deleted).
- **FR-18.** No self-service password change in this phase. (Future phase may add an "I forgot my password" flow.)
- **FR-19.** No self-service account deletion in this phase. Admin-only via FR-16.

### D. Auth middleware
- **FR-20.** Every `/api/*` route except `/api/auth/*` and `/api/health` requires a valid session. Missing/expired/unknown session → 401 JSON `{ error: "Authentication required" }`.
- **FR-21.** The middleware populates `request.user = { id, username, role }` from the session row.
- **FR-22.** The middleware uses `request.user` to scope DB + Qdrant queries on every downstream handler. No handler may "opt out" without explicit justification in code review.
- **FR-23.** The `/api/health` endpoint stays unauthenticated so the Docker HEALTHCHECK continues to work.
- **FR-24.** The `/api/auth/*` endpoints (`login`, `logout`, `register`, `invite/accept`, `me`) stay unauthenticated. `register` is open only until the first user exists (FR-1).
- **FR-25.** Static SPA assets (`/static/*`, the Vite-bundled `/assets/*`, and the SPA fallback `/{page}`) do not require auth — the SPA shell loads, then the route guard redirects unauthenticated users to `/login`.

### E. Documents & ownership (SQLite)
- **FR-26.** Migration `005_documents_owner.sql` adds two columns to `documents`:
  - `owner_id TEXT` (nullable; FK → `users.id` ON DELETE SET NULL — when a user is deleted, their owned files become shared).
  - `visibility TEXT NOT NULL DEFAULT 'public'` (one of `'public' | 'private'`).
  - Legacy rows (existing pre-Phase-04 documents) get `owner_id = NULL, visibility = 'public'`.
- **FR-27.** `POST /api/upload` accepts a `visibility` form field (`public|private`, default `private`). `owner_id` is stamped from `request.user.id`.
- **FR-28.** `POST /api/upload` returns the new document's `ownerUsername`, `visibility`, and the existing fields.

### F. Documents & ownership (Qdrant)
- **FR-29.** Every Qdrant chunk payload gains two fields: `ownerId: string | null` and `visibility: 'public' | 'private'`. The existing payload shape is unchanged otherwise.
- **FR-30.** On upload, the `ownerId` is set from `request.user.id`; `visibility` is set from the form value.
- **FR-31.** A migration pass iterates every existing point in the `documents` collection and `set_payload`s `ownerId = null, visibility = 'public'`. Idempotent (safe to re-run).
- **FR-32.** A new helper `buildVisibilityFilter(viewerId: string | null)` produces the Qdrant filter clause for "what this user can see":
  ```ts
  { must: [ { should: [
      { key: 'visibility', match: { value: 'public' } },
      { key: 'ownerId',     match: { value: viewerId } },
  ] } ] }
  ```
  (Anonymous callers — `viewerId = null` — see only public chunks. With Phase 04's "login required for all /api/*" decision, this is moot for the API surface, but the helper exists so future anonymous read paths don't accidentally leak.)
- **FR-33.** Payload indexes are added for `ownerId` (keyword) and `visibility` (keyword).

### G. Documents & ownership (HTTP surface)
- **FR-34.** `GET /api/documents` returns the union of "files I own" + "files with `owner_id = NULL`". Response shape: `{ documents: [{ fileId, fileName, fileType, bytes, chunkCount, uploadedAt, ownerUsername, visibility }, ...] }`.
- **FR-35.** `DELETE /api/documents/:fileId` succeeds if and only if the requesting user owns the file OR the file is shared (`owner_id IS NULL`). Otherwise 404 (not 403, to avoid leaking the file's existence).
- **FR-36.** `GET /api/download/:filename` returns the file only if the requesting user can see it (per FR-32). Otherwise 404.
- **FR-37.** `GET /api/upload/progress` (SSE) — no scoping needed; it doesn't expose file content. Auth still required.

### H. Search & chat ownership
- **FR-38.** `GET /api/search`, `GET /api/search/rag`, `POST /api/chat`, `POST /api/chat/stream` apply `buildVisibilityFilter(request.user.id)` to every Qdrant query (including expand-hits fetches and the agent tool's lookups).
- **FR-39.** The agent-loop tools (`get_neighbor_chunks`, `get_section_chunks`, `get_chunk`, `get_document`) all apply the same filter. If the LLM asks for a chunk by `fileId` that the user can't see, the tool returns an empty result / "not found" — never the chunk.
- **FR-40.** Filter behavior is verified by an integration test that uploads a private file as user A, logs in as user B, and asserts `/api/search` and `POST /api/chat` return no results for queries clearly targeting the private file's content.

### I. Conversations
- **FR-41.** Migration `006_conversations_owner.sql` adds `owner_id TEXT` to `sessions`. The migration DELETES all existing pre-Phase-04 `sessions` and `messages` rows (the user wants a clean slate — they answered "Drop pre-phase-4 conversations" on the design question). The `messages` table's `ON DELETE CASCADE` from `sessions` handles the row removal.
- **FR-42.** `POST /api/sessions` stamps `owner_id = request.user.id`.
- **FR-43.** `GET /api/sessions` returns only the current user's sessions.
- **FR-44.** `GET /api/sessions/:id`, `GET /api/sessions/:id/messages`, `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id` return 404 for sessions whose `owner_id ≠ request.user.id`. (Same opaque-404 rule as documents — no existence leak.)
- **FR-45.** `sessionId` URL regex stays `^[A-Za-z0-9_-]{1,64}$`.

### J. SPA
- **FR-46.** New pages: `Login.tsx`, `Register.tsx` (first-user only — shown only when `/api/auth/me` returns 401 AND `GET /api/auth/status` reports "first user available"), `InviteAccept.tsx` (`/register/:token`), `AdminUsers.tsx`, `AdminInvites.tsx`.
- **FR-47.** Route guard: any visit to `/chat`, `/upload`, `/documents`, `/admin/*` while unauthenticated redirects to `/login?next=<original-path>`.
- **FR-48.** `TopBar` shows the current `username` (right side); click reveals a menu with Logout + (if admin) Admin → Users, Admin → Invites.
- **FR-49.** `Upload.tsx`'s upload form gains a `Visibility` radio (Private default, Public).
- **FR-50.** `DocumentsList` shows an `Owner` column ("Shared" when null, username otherwise) and a `Visibility` chip (Public/Private). The Delete button is shown iff the user can delete that file (FR-35).
- **FR-51.** SPA state hooks (`useAuth`, `useDocuments`, `useSessions`) re-fetch on 401 and trigger a redirect to `/login`.

## Non-functional requirements
- **NFR-1.** Passwords are never returned in any API response. The `password_hash` column is never read by any endpoint other than the login path. A test asserts no `password` substring appears in any JSON response.
- **NFR-2.** Cookies: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV === 'production'`. `Max-Age = 30 * 24 * 3600`.
- **NFR-3.** Argon2id parameters: `memoryCost = 19456` (19 MiB), `timeCost = 2`, `parallelism = 1`. These are the OWASP-recommended minimums for argon2id as of 2024.
- **NFR-4.** The `argon2` npm package must build natively inside the existing Docker image (Alpine-based Node 20). If it doesn't, we fall back to `bcrypt` with `cost = 12` — the design documents both options; the choice is fixed by which builds cleanly.
- **NFR-5.** Session row lookups are indexed by `id` (primary key) — verified by an `EXPLAIN QUERY PLAN` test.
- **NFR-6.** The visibility filter MUST be applied on every Qdrant search / chat / tool path. Verified by an explicit test suite (see FR-40).
- **NFR-7.** The migration runner remains idempotent. Migrations 005 + 006 use `ALTER TABLE … ADD COLUMN` (which is idempotent in SQLite when guarded with `NOT EXISTS`-style column checks in the migration runner — see the existing pattern in `migrate.ts`) and `DELETE FROM` (idempotent when guarded by a row count check).
- **NFR-8.** No regression on `/api/health` (Docker HEALTHCHECK depends on it). A vitest test asserts the response is unchanged.
- **NFR-9.** All new endpoints are unit- or integration-tested via vitest (`fastify.inject`). End-to-end flows (signup → upload → cross-user check) are verified with `./restart.sh` + curl per `CLAUDE.md`.
- **NFR-10.** Logging: every auth event (`login`, `logout`, `register`, `invite_create`, `invite_accept`, `user_delete`, `password_reset`) is logged at INFO with `userId` (when known) and `actorUserId`.

## Constraints & assumptions
- **Stack continuity.** Phase 04 stays within the existing stack: Fastify, better-sqlite3, Qdrant, Ollama, OpenAI-compatible chat. No new infrastructure services.
- **Cookie scope.** The cookie is scoped to `localhost:3001` for dev; in a production deploy the user is responsible for serving over HTTPS (so the cookie's `Secure` flag activates). The SPA is served from the same origin as the API (port 3001), so no CORS / cross-origin cookie story.
- **No email.** There is no SMTP integration. Password recovery is admin-only (FR-17).
- **Single-tenant assumption at the database level.** DocKhoj remains one process, one SQLite file, one Qdrant collection. Phase 04 adds user scoping at the query level, not at the database level (no per-user databases). This is appropriate for the self-hosted single-server deployment profile.
- **Username, not email.** Users are identified by a short `username` rather than an email address. This keeps the data model small and removes any need for email validation / SMTP / verification flows.
- **No CSRF tokens.** All mutating endpoints accept JSON (`Content-Type: application/json`) or multipart form data with a same-origin check (the SPA is served from the same origin as the API). `SameSite=Lax` cookies + same-origin = CSRF mitigated. Phase 04 does not add a CSRF token; if the deployment topology ever splits, we'll add one.
- **No rate limiting in Phase 04.** A misbehaving user could brute-force logins. Accepted risk for the self-hosted deployment; flagged in `design.md` risks.

## Acceptance criteria
The phase is complete when:
1. `./restart.sh` brings the stack up on a clean volume with no manual steps.
2. A new user can register as the first user via the SPA, log in, and use the app.
3. A second user, registered via an invite link, can log in and use the app.
4. The first user can list, create, and revoke invites.
5. User A uploads a private file; user B's `/api/search`, `/api/chat`, and `POST /api/chat/stream` cannot retrieve its chunks or surface it in their document list.
6. User A marks a file public; user B sees it in their documents list and can delete it.
7. User B cannot delete user A's private file (gets 404).
8. Logging out invalidates the session server-side; the cleared cookie cannot be replayed.
9. Existing pre-Phase-04 documents appear as shared files in every user's documents list.
10. Pre-Phase-04 conversations are gone from the database (verified by `SELECT COUNT(*) FROM sessions` returning 0 immediately after migration on a Phase-03 database).
11. `/api/health` returns 200 without auth (Docker HEALTHCHECK still works).
12. Vitest passes; `./restart.sh` + curl walkthrough of the user stories above produces no errors.

## Out of scope
- OAuth / external IdP integration.
- Email-based password reset.
- File-level ACLs beyond the binary public/private visibility flag (no "share with specific users").
- Per-user rate limiting / login throttling.
- Audit log of admin actions.
- Self-service account deletion.
- Account lockout after failed logins.
- The "share my private file" UI button (Phase 04 supports `owner_id = NULL` only via legacy uploads; no UI path to set a file's `owner_id` to NULL after upload).
- Pagination on `/api/documents` and `/api/sessions`.

## Open questions
- **Q1.** Account lockout after N failed logins? **Defaulted to no** for Phase 04 (deferred; user can request it).
- **Q2.** When an admin deletes a user, should their public-marked files become shared (current design — `owner_id` set to NULL on user delete) or be deleted along with the user's private files? **Defaulted to: public files become shared.** Documented in FR-16. The user can override.
- **Q3.** Should the SPA show a "You have N unread invites" indicator for admins? **Defaulted to no.** The admin page lists outstanding invites on demand.
- **Q4.** Username changes — should users be able to rename themselves? **Defaulted to no** for Phase 04. Admin can rename in a future task.
- **Q5.** When `sessionId` ownership changes (a future "transfer session" feature), how does the migration handle it? N/A in Phase 04.
- **Q6.** Anonymous read access to public files via a future `/api/public/search` endpoint? **Out of scope** for Phase 04 per the user's design answer ("Login required for all /api/* endpoints").