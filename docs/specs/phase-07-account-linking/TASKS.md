# Phase 07 — Tasks: Account linking

Each task is sized for one sitting. Order is the execution sequence;
`Status` updates as work proceeds. `Layer` makes overlapping touch
surfaces visible at a glance. The dependency graph + parallel
workgroups + critical path tables are at the bottom.

---

## T01 — Extend OIDC state format with `mode` + `linkUserId`

**Description.** Widen `OidcState` with optional `mode: 'login' | 'link'`
and `linkUserId?: string`. Update `verifyState` to accept them
(defaulting `mode` to `'login'` when absent — preserves Phase 06
cookies). Update `newLoginState` to take an optional second arg
(`{ mode: 'link'; linkUserId: string }`) and embed both fields when
provided. Extract the inline IdP authorize-URL builder from
`api-auth-oidc.ts:202-211` into a new `buildAuthorizeUrl(cfg, state,
nonce, challenge)` helper in `oidc.ts` (Phase 07 introduces a
second caller; Phase 06 alone didn't justify the abstraction). The
refactor is mechanical — `api-auth-oidc.ts` switches one call site
to the helper.

**Maps to requirements:** NFR-1 (back-compat), NFR-2 (state cookie
carries link intent), FR-5 (mode field), FR-6 (linkUserId).

**Maps to design:** §"State-cookie format change (back-compat)",
§"newLoginState gains an optional 2nd arg (ponytail)",
§"IdP authorize URL construction (ponytail)".

**Acceptance criteria:**
- `OidcState` type has the new optional fields; `verifyState` accepts
  Phase 06 cookies (no `mode`) as `mode='login'`.
- A cookie signed with `mode='link', linkUserId='abc'` round-trips
  through sign + verify with both fields preserved.
- A cookie with `mode='link'` but no `linkUserId` fails verify (returns
  null).
- `newLoginState('/chat')` produces a cookie that decodes as
  `mode='login'`.
- `newLoginState('/account', { mode: 'link', linkUserId: 'abc' })`
  produces a cookie that decodes as `mode='link', linkUserId='abc'`.
- `buildAuthorizeUrl` exists in `oidc.ts`; the existing
  `/api/auth/oidc/login` route still 302s to the same IdP URL it
  did before this commit (regression check).
- Vitest `tests/services/oidc-state.test.ts` extended with the new
  round-trip cases; all green.

**Dependencies:** none.

**Estimate:** S.

**Status:** todo.

**Notes:** The `buildAuthorizeUrl` extraction touches
`api-auth-oidc.ts` (Phase 06 file). It is the only edit in T01 to a
non-`oidc.ts` file. Keeping it inside T01's commit means T02
(another `api-auth-oidc.ts` editor) doesn't race with T03 (which
also wants `buildAuthorizeUrl`).

---

## T02 — Add link-mode branch to OIDC callback

**Description.** In `GET /api/auth/oidc/callback`, after the existing
state verify → token exchange → id_token verify → group check
pipeline (all unchanged), branch on `stored.mode`. When
`mode === 'link'`:

1. Require the session cookie; require its `user_id` to equal
   `stored.linkUserId`. Otherwise → `/login?oidc_error=link_session`.
2. Reject if the user already has any identity row →
   `/login?oidc_error=link_already`.
3. Insert `user_identities(linkUserId, issuer, sub)` with race-safe
   catch on the UNIQUE constraint. Same-user race → `/account?linked=ok`.
   Other-user race → `/login?oidc_error=link_conflict`.
4. Redirect to `/account?linked=ok` on success. **Do not** call
   `sessions.create` or `setSessionCookieHeader` — the user already
   has a session.

The login-mode branch (default) is structurally unchanged.

**Maps to requirements:** FR-6 (link mode inserts identity row for
current user), FR-7 (linkUserId must match real user), FR-8
(link-already), FR-9 (link-conflict), FR-10 (login mode unchanged),
US-9, US-10.

**Maps to design:** §"Modified: GET /api/auth/oidc/callback",
§"Session match at link callback".

**Acceptance criteria:**
- Existing Phase 06 callback tests still pass (login mode unchanged).
- New tests cover: link happy path, link-session-missing,
  link-already, link-conflict, same-user race (two concurrent
  callbacks land at `/account?linked=ok`).
- Link-mode callback does NOT set a new `dockhoj_sid` cookie.
- Link-mode callback logs `{ event: 'oidc_linked', userId, issuer,
  sub }` on success.
- Group-denied link attempts still redirect to `?oidc_error=denied`
  (the gate runs BEFORE the link branch).

**Dependencies:** T01 (mode + linkUserId must exist in the state
type and `verifyState`).

**Estimate:** M.

**Status:** todo.

---

## T03 — Create `/api/account/*` routes

**Description.** New file `src/routes/api-account.ts`. Three routes:

1. `GET /api/account/link/status` (auth required). Returns
   `{ password: { set: boolean }, oidc: { linked: boolean, issuer?:
   string, linkedAt?: string } }`.
2. `POST /api/account/link/sso/start` (auth required, body
   `{ password }`). Verifies password, signs a state cookie with
   `mode='link', linkUserId=user.id`, returns
   `{ location: '<idp authorize url>' }` (200). Errors: 400
   sentinel, 401 wrong password, 409 already linked, 503 OIDC not
   configured.
3. `POST /api/account/link/sso/unlink` (auth required, body
   `{ password }`). Verifies password, deletes all
   `user_identities` rows for the user in a transaction, returns
   `{ linkedMethods: ['password'] }`. Errors: 400 sentinel, 401
   wrong password.

The plugin follows the same shape as `api-auth-oidc.ts`:
constructor reads `(fastify as unknown as { db }).db`, instantiates
the stores, registers routes. Reuses `newLoginState` from T01,
`verifyPassword` from `password.ts`, `loadOidcConfig` from
`oidc.ts`. Registers the plugin in `src/index.ts` next to
`oidcAuthRoutes` and `authRoutes`.

**Maps to requirements:** FR-1 (link status source of truth),
FR-2 (link status endpoint), FR-3 (link start), FR-4 (link unlink),
NFR-2 (password re-auth).

**Maps to design:** §"New: GET /api/account/link/status",
§"New: POST /api/account/link/sso/start", §"New: POST
/api/account/link/sso/unlink".

**Acceptance criteria:**
- Three routes registered; curl tests in
  `tests/routes/api-account.test.ts` cover all happy + error
  branches (AC per design §"Testing strategy").
- `/link/sso/start` returns a `location` URL with the standard
  authorize URL shape (response_type, client_id, redirect_uri,
  scope, state, nonce, code_challenge, code_challenge_method).
- `/link/sso/unlink` deletes every `user_identities` row for the
  user in a single transaction.
- Sentinel-hash users get 400 (not 401) on both endpoints with the
  message "Account has no password" / "Account has no password;
  cannot unlink the only login method".
- Plugin is registered in `src/index.ts`; the route surface is
  reachable from `curl localhost:3001/api/account/link/status`
  with a valid session cookie.

**Dependencies:** T01 (uses `newLoginState(next, link)`).

**Estimate:** M.

**Status:** todo.

---

## T04 — Add `linkedMethods` to `/api/auth/me`

**Description.** `GET /api/auth/me` adds an additive field
`linkedMethods: Array<'password' | 'oidc'>`. Computed once at
request time:

- `'password'` is in the array iff `user.password_hash !== '!oidc!'`.
- `'oidc'` is in the array iff `SELECT 1 FROM user_identities WHERE
  user_id = ?` returns ≥ 1 row.

The middleware in `src/services/auth.ts` populates `request.user`
with this field (one extra `db.prepare().get()` per request, PK
lookup on the indexed `user_id`). The `/me` handler reads it from
`request.user`.

**Maps to requirements:** FR-11.

**Maps to design:** §"Modified: GET /api/auth/me".

**Acceptance criteria:**
- `/me` returns `{ id, username, role, linkedMethods }`.
- Password-only user → `linkedMethods: ['password']`.
- OIDC-provisioned user → `linkedMethods: ['oidc']`.
- Linked user (password hash + identity row) →
  `linkedMethods: ['password', 'oidc']`.
- Existing `/me` consumers (SPA `useAuth`) keep working; the new
  field is additive and not required by the type.
- Vitest `tests/routes/api-auth.test.ts` extended.

**Dependencies:** none (independent of T01..T03).

**Estimate:** S.

**Status:** todo.

---

## T05 — UserMenu "Account" entry + register `/account` route

**Description.** SPA wiring only. Two edits:

1. `web/src/components/UserMenu.tsx`: add a `<Link href="/account">`
   entry to the dropdown above the admin entries, available to all
   roles. Closes the dropdown on click (same pattern as admin links).
2. `web/src/App.tsx`: register `<Route path="/account">` inside the
   `<Switch>`, wrapped in `<RouteGuard>` (no `requireRole` — all
   authenticated users).

The `/account` component itself is T06.

**Maps to requirements:** FR-14 (UserMenu), FR-13 (route registration
scaffold).

**Maps to design:** §"UserMenu addition (FR-14)".

**Acceptance criteria:**
- Clicking the username chip → "Account" navigates to `/account`.
- `RouteGuard` redirects unauthenticated users from `/account` to
  `/login?next=/account`.
- The dropdown shows "Account" for non-admin users; admin users see
  "Account" + the admin entries + Logout, in that order.
- No `/account` 404 — the SPA route resolves.

**Dependencies:** T03 (the `/account` component calls the API routes
added in T03, but T05 only wires the navigation; T06 brings the
component). Soft dependency — could ship T05 first and the SPA would
navigate to a missing page for one commit; safer to keep the ordering.

**Estimate:** XS.

**Status:** todo.

---

## T06 — Implement `/account` SPA route + Login error mapping

**Description.** Two edits:

1. New file `web/src/routes/Account.tsx`. Renders three sections:
   (a) success banner when `?linked=ok`; (b) Profile panel
   (username + role, read-only); (c) Linked-accounts panel
   (Password + SSO status, link/unlink inline forms per design.md
   §"SPA /account"). Fetches `/api/account/link/status` on mount.
   Submit handlers POST to `/api/account/link/sso/{start,unlink}`
   with the user-entered password; on success of `start`, SPA does
   `window.location.assign(location)` for full-page nav to the IdP;
   on success of `unlink`, SPA refreshes `useAuth` and updates
   local state.
2. `web/src/routes/Login.tsx`: add 3 entries to
   `OIDC_ERROR_MESSAGES`:
   - `link_session` → "Your session expired before the link
     completed. Sign in again and try again."
   - `link_already` → "Single sign-on is already linked to your
     account."
   - `link_conflict` → "That identity is already linked to another
     account. Contact your administrator."

Inline forms (not a modal lib) — matches the existing SPA pattern
(Register.tsx, InviteAccept.tsx).

**Maps to requirements:** FR-13 (account page), FR-15 (linked=ok
banner), FR-16/17/18 (error mapping).

**Maps to design:** §"SPA /account (FR-13 / FR-14)".

**Acceptance criteria:**
- `/account` renders without console errors when fetched with a
  valid session cookie.
- Password user → "Link single sign-on" button visible.
- OIDC-only user → no link/unlink buttons; both panels show correct
  status.
- Linked user (both methods) → "Unlink single sign-on" button
  visible.
- Submitting the link form with the right password → SPA navigates
  to the IdP URL.
- Submitting the unlink form with the right password → panel flips
  to "not linked" without a full-page reload.
- `?oidc_error=link_session` etc. on `/login` renders the new
  message above the password form.

**Dependencies:** T03 (uses the API routes), T05 (component mounted
at `/account`).

**Estimate:** M.

**Status:** todo.

---

## T07 — E2E walkthrough via `./restart.sh` + curl

**Description.** Run the AC-1 walkthrough from `design.md §"Testing
strategy"` against the live Docker stack. Capture the curl session
in the fold-in commit body (per project CLAUDE.md §1.4: code first,
explanatory prose only when explicitly requested — E2E walkthrough
is one such request, see requirements.md AC-1).

Walkthrough steps:

1. `./restart.sh` — fresh stack with OIDC configured (use the
   `.env` from prior E2E setups; if no IdP is available, mock one
   via `mockOidcServer` helper if it exists, otherwise configure
   Keycloak via Docker — out of scope to add a new mock just for
   Phase 07).
2. Register password user `alice` via `/api/auth/register`.
3. Sign in as alice via `/api/auth/login`.
4. POST `/api/account/link/sso/start` with alice's password →
   expect `{ location: '<idp url>' }`.
5. (IdP redirect + callback — exercised by vitest; on the live
   stack, follow the location manually in a browser if a real IdP
   is configured. If not, mark this step as "covered by vitest;
   live IdP deferred" and continue.)
6. GET `/api/auth/me` → expect `linkedMethods: ['password',
   'oidc']`.
7. POST `/api/account/link/sso/unlink` → expect 200.
8. GET `/api/account/link/status` → expect
   `oidc.linked: false`.
9. POST `/api/account/link/sso/start` → expect 409.

Document each step's actual output in the fold-in commit body.

**Maps to requirements:** AC-1, AC-10.

**Maps to design:** §"E2E walkthrough".

**Acceptance criteria:**
- `./restart.sh` rebuilds cleanly; `/api/health` is green.
- All 9 walkthrough steps produce the expected output.
- The fold-in commit message includes the walkthrough.

**Dependencies:** T05, T06.

**Estimate:** S.

**Status:** todo.

---

## T08 — docs fold-in + delete phase folder

**Description.** Per spec-workflow Step 7. Single commit,
`chore(phase-07): fold in and delete` prefix, containing in this
order:

1. `// why:` comments at the call sites that lock in non-obvious
   decisions:
   - `src/services/oidc.ts` — the `newLoginState(next, link?)`
     ponytail comment.
   - `src/routes/api-auth-oidc.ts` — the link-mode branch + the
     session-match comment.
   - `src/routes/api-account.ts` — "smallest possible scope for
     account linking".
   - `src/services/auth.ts` — why `linkedMethods` is computed
     inline rather than stored.
2. `docs/architecture.md` updates:
   - Add a "Phase 07" section after the "Phase 06" section:
     - The two-path login-mode / link-mode flow (Mermaid sequence
       diagram).
     - The password re-auth defence (NFR-2).
     - The session-match at link callback (FR-7).
     - The state-cookie format extension (FR-5).
   - Add Phase 07 row to the Phase history table.
3. Delete `docs/specs/phase-07-account-linking/` (the whole
   folder).
4. Verify nothing else in the repo references the folder.

**Maps to requirements:** AC-1 (walkthrough captured), §"Spec
workflow reminder" (project CLAUDE.md).

**Maps to design:** §"Implementation order" final step.

**Acceptance criteria:**
- `docs/architecture.md` contains a Phase 07 section + Phase history
  row.
- `docs/specs/phase-07-account-linking/` does not exist on disk
  (deleted).
- `git grep phase-07-account-linking` returns no hits in code
  (only in git log if you go looking).
- All Phase 07 // why: comments are present at the call sites.

**Dependencies:** T07.

**Estimate:** S.

**Status:** todo.

---

## Dependency graph

| ID | Title | Layer | Depends on | Blocks | Estimate |
|---|---|---|---|---|---|
| T01 | OIDC state format + `buildAuthorizeUrl` | service | — | T02, T03 | S |
| T02 | Link-mode branch in callback | api | T01 | T07 (E2E) | M |
| T03 | `/api/account/*` routes | api | T01 | T06, T07 | M |
| T04 | `/me` `linkedMethods` | api | — | T07 | S |
| T05 | UserMenu + `/account` route registration | spa | — | T06, T07 | XS |
| T06 | `Account.tsx` + Login error map | spa | T03, T05 | T07 | M |
| T07 | E2E walkthrough (`./restart.sh` + curl) | e2e | T02, T03, T04, T05, T06 | T08 | S |
| T08 | docs fold-in + delete phase folder | docs | T07 | — | S |

## Parallel workgroups

| Gate | Parallel tasks (no shared files) |
|---|---|
| After **T01** | `T02` (src/routes/api-auth-oidc.ts) ∥ `T03` (src/routes/api-account.ts new) ∥ `T04` (src/routes/api-auth.ts + src/services/auth.ts) |
| After **T02, T03, T04** | `T05` (web/src/components/UserMenu.tsx + web/src/App.tsx) ∥ `T06` (web/src/routes/Account.tsx new + web/src/routes/Login.tsx) |
| After **T05 + T06** | `T07` (./restart.sh + curl, no code) ∥ `T08` (docs/architecture.md + phase folder deletion) |

T01 is the only task that touches a Phase 06 file outside of its
intended surface (`api-auth-oidc.ts`, for the `buildAuthorizeUrl`
extraction). T01 places the helper in `oidc.ts` so T02 and T03
import it without further edits to `api-auth-oidc.ts`. T02 then
edits `api-auth-oidc.ts` (callback branch) without overlap with
T03 or T04.

## Critical path

**T01 → T03 → T06 → T07 → T08.**

Wall-clock lives on the chain where each step depends on the
previous. Everything parallelized off the chain is free:

- T02 + T04 + T05 run in parallel after T01 (server layer) or
  after T01..T04 (SPA layer).
- T07 must run after T06 because the E2E walkthrough exercises the
  `/account` page.
- T08 is sequenced after T07 because the fold-in commit captures
  the E2E walkthrough.

If a subagent (phase-swarm) is fanning out work, it should claim
T01 first, then dispatch T02/T03/T04 in parallel from one agent,
then T05/T06 from another, then T07 inline (E2E benefits from a
single context window), then T08 inline (fold-in is a single
deliberate commit).