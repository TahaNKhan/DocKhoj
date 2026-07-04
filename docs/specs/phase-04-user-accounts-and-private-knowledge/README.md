# Phase 04 — User Accounts and Private Knowledge

**Status:** done
**Started:** 2026-07-03
**Done:** 2026-07-04

## Isolation
- **Branch:** `phase/04-user-accounts-and-private-knowledge` (proposed — large architectural phase, multi-day, auth + schema + SPA)
- **Worktree:** `.claude/worktrees/phase-04-user-accounts-and-private-knowledge/` (proposed)

## Pointers
- **Tasks:** `p4-T01` … in [`./TASKS.md`](./TASKS.md) (this folder)
- **Spec:** [`./requirements.md`](./requirements.md), [`./design.md`](./design.md)
- **Related specs:** Phase 01 (`../phase-01-smart-chunker-and-cleanup/`), Phase 02 (`../phase-02-frontend-streaming-and-persistence/`), Phase 03 (`../phase-03-document-deletion-and-agentic-rag/`)

## Why isolated
Phase 04 introduces a real user model. Every existing assumption (single-tenant, no auth, free-for-all visibility) changes:

- **New persistence:** users, sessions, invites tables; `owner_id` + `visibility` columns on `documents`; `owner_id` + `visibility` payload fields on every Qdrant chunk.
- **New auth layer:** HTTP middleware that rejects unauthenticated `/api/*` calls except `/api/auth/*` and `/api/health`; server-side sessions via HttpOnly cookies; Node stdlib `crypto.scrypt` password hashing (no native build).
- **Qdrant filter rewrite:** every search path (`/api/search`, `/api/search/rag`, `/api/chat`, `/api/chat/stream`, agent-loop tools) must apply an ownership/visibility filter. This is the load-bearing change — one missed path leaks another user's private chunks.
- **SPA rewrite:** new `/login`, `/register`, `/register/:inviteToken`, `/admin/users`, `/admin/invites` pages; route guard; top-bar user menu; upload-page visibility toggle; documents-list owner column.
- **Conversations get scoped** to their owner; pre-phase-04 conversations are dropped to give the user a clean slate for the new ownership model.

The diff is server-wide, SPA-wide, and schema-wide. A dedicated branch + worktree is the right call: auth changes destabilize everything until the end.

## Scope summary
- **Users & auth**
  - `users` SQLite table (`id`, `username`, `password_hash`, `role` (`admin|user`), `created_at`, `last_login_at`).
  - `sessions` SQLite table (`id`, `user_id`, `created_at`, `expires_at`, `last_seen_at`).
  - `invites` SQLite table (`id`, `token_hash`, `created_by`, `created_at`, `expires_at`, `used_by`, `used_at`).
  - `crypto.scrypt` password hashing (Node stdlib, no native build, hash format `scrypt$N$r$p$salt$derived` keeps a future argon2id swap as a single-file verify-path change).
  - HttpOnly, SameSite=Lax cookie `dockhoj_sid` carrying the opaque session id; 30-day rolling expiry; server-side revocation by deleting the row.
  - New endpoints:
    - `POST /api/auth/register` — first-user-only, subsequent calls return 403.
    - `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
    - `POST /api/auth/invite/accept` — accept an invite token, create the user, establish a session.
    - `POST /api/admin/invites` — create invite (admin only).
    - `GET  /api/admin/invites` — list outstanding invites (admin only).
    - `DELETE /api/admin/invites/:id` — revoke invite (admin only).
    - `GET  /api/admin/users` — list users (admin only).
    - `DELETE /api/admin/users/:id` — delete user + their documents + their sessions (admin only; cannot delete self).
    - `POST /api/admin/users/:id/password` — admin reset of another user's password.
  - Fastify decorator `request.user` populated from the session cookie on every `/api/*` request; `onRequest` hook returns 401 JSON for missing/expired sessions on protected paths.
- **Documents & ownership**
  - Migration `005_documents_owner.sql` adds `owner_id TEXT` and `visibility TEXT` to `documents`; legacy rows get `owner_id = NULL, visibility = 'public'`.
  - Qdrant payload gains `ownerId: string | null` and `visibility: 'public' | 'private'` on every chunk. Backfilled during the migration by iterating all points and `set_payload`-ing the two fields.
  - New `qdrant.ts` helper `buildVisibilityFilter(viewerId)` producing the "what can this user see" filter clause: `must: [ should: [ {visibility=public}, {ownerId=self} ] ]`.
  - Search paths (`/api/search`, `/api/search/rag`), chat paths (`/api/chat`, `/api/chat/stream`), and every agent tool (`get_neighbor_chunks`, `get_section_chunks`, `get_chunk`, `get_document`) apply this filter. The agent loop uses the same filter so the LLM cannot reach another user's private chunks via the tool surface.
  - Upload endpoint accepts `visibility` in the multipart form (default `private`); `ownerId` is set from `request.user.id`.
  - Delete endpoint behavior scoped: a user can delete their own files + any file in the shared bucket (owner_id IS NULL); they CANNOT delete another user's private files.
  - Documents list endpoint scoped the same way; the response shape adds `ownerUsername` (nullable) and `visibility` fields.
- **Conversations**
  - Migration `006_conversations_owner.sql` adds `owner_id TEXT` to `sessions`; the migration ALSO deletes all pre-phase-04 rows (the user wants a clean slate for the new ownership model).
  - `POST /api/sessions` now stamps `owner_id` from the request user.
  - Session listing scoped: a user sees only their own sessions.
  - All session/message routes (`GET/PATCH/DELETE /api/sessions/:id`, `GET /api/sessions/:id/messages`) return 404 for sessions owned by another user.
- **Shared bucket semantics** — files with `owner_id = NULL` (legacy uploads + any future "share with everyone" flow we may add; not exposed in the Phase 04 UI, but the data model supports it) are visible to every logged-in user. Any logged-in user can delete, re-chunk, or re-upload against a shared file. Per the user's explicit requirement: "any users can manage (or delete)".
- **SPA**
  - `Login.tsx`, `Register.tsx`, `InviteAccept.tsx` pages, hooked into a `useAuth()` hook backed by `/api/auth/me`.
  - Route guard: any `/chat`, `/upload`, `/documents` route while unauthenticated → redirect to `/login?next=…`.
  - `TopBar` gets a user menu (username + logout button on click; admin links to `/admin/users` + `/admin/invites` for admin role).
  - `Upload.tsx` upload form gets a `Visibility` toggle (Private default, Public opt-in).
  - `DocumentsList` gets an `Owner` column (blank for shared) and a `Visibility` chip; "Delete" button is shown for any document the user can delete.
  - `AdminUsers.tsx`, `AdminInvites.tsx` pages for the admin role.

## Out of scope (this phase)
- OAuth / external IdPs. Local username + password only.
- Email-based password reset (no SMTP). Admin can set a new password for another user (the user flag in the spec).
- File ownership transfer. A user cannot transfer a file to another user in this phase.
- Per-file sharing (sharing a private file with specific users). The visibility model is binary: public-to-all-logged-in-users or private-to-owner-only.
- Document redaction / row-level filtering on Qdrant payloads beyond `ownerId` / `visibility`.
- Audit log of admin actions.
- Rate limiting per user.
- Account lockout after N failed logins.
- The "shared bucket" is a per-row `owner_id = NULL` flag — there is no separate "share" UI in Phase 04; the only way a file becomes shared is by being a legacy file that pre-dates user assignment. Phase 05+ may add an explicit "share" button that sets `owner_id = NULL`.
- Pagination on `/api/documents` for very large libraries (Phase 04 lists everything the user can see; if performance becomes a concern, pagination is a Phase 05+ task).

## Decisions deferred to review
See `requirements.md` → "Open questions" and `design.md` → "Open decisions".
