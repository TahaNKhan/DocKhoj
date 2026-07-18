# Phase 07 — Requirements: Account linking

## Purpose

A user who signs up with username + password should be able to also
log in via SSO (and vice versa, in the future). Today the two auth
methods are disjoint: password users have a real scrypt hash and no
`user_identities` row; OIDC users have the `'!oidc!'` sentinel hash
and one `user_identities` row each. This phase introduces a *linking
flow* that binds an OIDC identity to an existing password user,
without forcing the password user to give up password login.

## Users / actors

- **Password user.** A person who created an account via `/register`
  (first user) or `/api/auth/invite/accept`. They have a real scrypt
  hash, no `user_identities` rows. After Phase 07 they can opt into
  linking SSO from `/account`.
- **OIDC user.** A person whose first login was via SSO. They have
  the sentinel hash and one `user_identities` row. They can log in
  via SSO only (no password to authenticate with). Out of scope to
  add a password to them in this phase — see §"Out of scope".
- **Operator.** Owns the install. May disable OIDC by toggling
  `OIDC_ENABLED=false`. May delete users (cascades to identities).
- **Admin.** A user with `role='admin'`. Has no privileged actions
  specific to account linking — they can manage users, but linking
  is initiated by the user themselves.

## Design choice — flag at review

The current `users` table has **no email column**, so the system
cannot match "SSO identity with email alice@co" against "password
user alice" without an additional schema migration. To keep the
change small and to avoid the auto-link takeover risk (someone who
controls only the IdP account takes over the DocKhoj password
account), this phase adopts the **explicit link initiated by the
password user from `/account`** model:

1. User signs in with username + password (as today).
2. User navigates to `/account`.
3. User clicks **"Link single sign-on"**.
4. Server requires the user to re-confirm their password (defence
   in depth: a stolen browser session can't bind SSO without the
   password).
5. User completes the SSO flow.
6. At callback, the server binds the `(issuer, sub)` pair to the
   *currently authenticated* user rather than creating a new one.
7. The user can now log in via either method.

This is the same flow every consumer SaaS uses ("Settings → Linked
accounts → Connect"), and it requires no schema change beyond a
nullable `link_methods` marker on `/api/auth/me` (an additive
informational field, no DB migration).

**Alternative considered and rejected for this phase:**
auto-link-on-first-SSO-login, which would require an `email` column
on `users` (migration 009), a matching step at the OIDC callback,
and a stricter threat model review. Filed as a follow-up if a real
user asks for it.

## User stories / flows

### US-1 — Password user links SSO (happy path)

1. Alice (password user `alice`) signs in at `/login`.
2. Alice clicks her username chip → "Account" → lands on `/account`.
3. `/account` shows: "Password: ✓" and "Single sign-on: not linked"
   (because `/api/auth/status` reports `oidc.enabled === true`).
4. Alice clicks **"Link single sign-on"**.
5. SPA calls `POST /api/account/link/sso/start` with the user's
   current password. Server verifies the password against the
   current user's hash. On success, server signs a one-shot state
   cookie with `mode: 'link'`, `linkUserId: <alice.id>`, and the
   usual PKCE/state/nonce/next fields; redirects to the IdP.
6. Alice authenticates at the IdP.
7. IdP redirects to `/api/auth/oidc/callback?code=&state=`.
8. Server verifies state + nonce + id_token as today. Detects
   `mode: 'link'`. **Skips** find-or-create-by-`(issuer,sub)`.
   Instead, inserts a `user_identities` row for the
   already-authenticated `linkUserId`. Redirects to `/account?
   linked=ok`.
9. `/account` now shows "Single sign-on: linked to
   `<provider-host>`".

### US-2 — Linked user logs in via SSO (subsequent logins)

1. Alice returns tomorrow. She goes to `/login` and clicks
   **"Sign in with SSO"**.
2. Server signs a fresh state cookie with `mode: 'login'`
   (default — current behaviour), redirects to IdP.
3. Alice authenticates. IdP redirects to `/callback`.
4. Server verifies state + id_token. `mode: 'login'` →
   `findOrCreateOidcUser` runs. It finds the existing
   `user_identities` row → returns Alice. Session is created.
   Redirects to `/chat`.

### US-3 — Linked user logs in with password (unchanged)

1. Alice clicks "Sign in with username + password" on `/login`.
2. `POST /api/auth/login` validates the password against Alice's
   hash. Identical to today; no special-casing.

### US-4 — Linked user unlinks SSO

1. Alice on `/account` clicks **"Unlink single sign-on"**.
2. SPA confirms via a modal. `POST /api/account/link/sso/unlink`.
3. Server checks: the user must still have a working password
   (i.e. `password_hash` is not the `'!oidc!'` sentinel and
   `verifyPassword` against the stored hash succeeds — re-auth
   again, same defence-in-depth reasoning as US-1 step 5).
4. Server deletes every `user_identities` row for this user
   (`DELETE FROM user_identities WHERE user_id = ?`). FK cascade
   handles the rare case of admin-initiated user delete.
5. Server returns `{ linkedMethods: ['password'] }`. SPA updates
   the page.

### US-5 — User links SSO then signs out and back in via SSO

1. Alice links SSO (US-1).
2. Alice clicks Logout.
3. Alice visits `/login`, clicks **"Sign in with SSO"** (US-2).
4. Alice is logged in.

This is the round-trip that proves "either method works after
linking" without changing the SSO login path.

### US-6 — Password user attempts to link but cancels the IdP flow

1. Alice clicks "Link single sign-on", re-confirms password.
2. Alice closes the IdP tab without authenticating. No callback
   ever arrives. The state cookie expires after 5 minutes (TTL
   unchanged). Nothing in the DB changes. Alice can retry.

### US-7 — User is already linked; attempts to re-link

1. Alice (already linked) clicks "Link single sign-on" again.
2. SPA sees `linkedMethods.includes('oidc')` from `/api/auth/me`
   and disables the button with the label "Already linked".
3. If she somehow bypasses the UI and POSTs to
   `/api/account/link/sso/start` anyway, the server checks: does
   the user already have an identity row for *any* issuer? If
   yes, 409 `already_linked`. The endpoint never deletes the
   existing row — unlinking is its own explicit step (US-4).

### US-8 — Operator disabled OIDC after a user linked

1. Alice linked SSO yesterday.
2. Operator sets `OIDC_ENABLED=false` in `.env` and restarts.
3. Alice visits `/login`. The "Sign in with SSO" button is gone
   (`/api/auth/status` returns `oidc.enabled: false`).
4. Alice can still log in with password. The orphaned
   `user_identities` row is harmless — no code path reads it
   when OIDC is disabled.
5. Admin can run `DELETE FROM user_identities WHERE user_id =
   '<alice.id>'` to clean up (not exposed in the UI; out of
   scope).

### US-9 — Link callback arrives but no session

1. Alice clicks "Link single sign-on", re-confirms password, gets
   redirected to the IdP.
2. Alice's session expires (or she logs out in another tab)
   before completing the IdP flow.
3. The IdP redirects her to `/callback`. The state cookie has
   `mode: 'link'`, but the auth middleware sees no session.
4. Server redirects to `/login?oidc_error=link_session` —
   distinct code from the existing errors so the SPA can render
   "Sign-in session expired; please sign in and try again."

### US-10 — OIDC callback in link mode but `(issuer, sub)` already linked to *another* user

1. Alice (password user) starts linking SSO.
2. The IdP happens to issue the same `sub` for someone else who
   already linked (extremely rare — same IdP tenant, identical
   subject claim). Or more realistically: Alice is in
   "link mode" but the `(issuer, sub)` row points to a different
   local user from a previous installation that was restored.
3. Server detects the conflict: the `user_identities` row's
   `user_id` ≠ the `linkUserId` from the state cookie.
4. Server does NOT overwrite the existing link. Redirects to
   `/login?oidc_error=link_conflict`. SPA renders: "That
   identity is already linked to another account. Contact your
   administrator."

## Functional requirements

### Linking

- **FR-1.** `GET /account` (SPA route) shows a "Linked accounts"
  panel: `Password` (always listed; ✓ if real hash, ✗ if sentinel),
  `Single sign-on` (✓ if linked, ✗ if not — only rendered when
  `/api/auth/status.oidc.enabled === true`).
- **FR-2.** `GET /api/account/link/status` returns
  `{ password: { set: boolean }, oidc: { linked: boolean,
  issuer?: string, linkedAt?: string } }` for the authenticated
  user. Used by `/account` for its initial paint.
- **FR-3.** `POST /api/account/link/sso/start` requires the user's
  current password (body: `{ password }`). On success it signs a
  one-shot state cookie with `mode: 'link'` + `linkUserId` and
  redirects (`302`) to the IdP. Returns 401 if the password is
  wrong (no enumeration; identical message to `/api/auth/login`).
  Returns 409 if the user already has an OIDC identity (any
  issuer). Returns 503 if OIDC is not configured.
- **FR-4.** `POST /api/account/link/sso/unlink` requires the user's
  current password (body: `{ password }`). On success deletes all
  `user_identities` rows for the user. Returns 400 if the user
  has no password (sentinel hash) — there's nothing to fall back
  to. Returns 401 on bad password.

### OIDC callback in link mode

- **FR-5.** The OIDC state cookie's signed payload gains an
  optional `mode: 'login' | 'link'` field. Default is `'login'`
  when absent (back-compat with Phase 06 cookies).
- **FR-6.** In link mode, after the standard state + id_token +
  group checks, the callback inserts a new `user_identities` row
  pointing at `linkUserId` (instead of running
  `findOrCreateOidcUser`). It does NOT set a session cookie (the
  user already has one). It redirects to `/account?linked=ok`.
- **FR-7.** If `linkUserId` is not the id of a real user, redirect
  to `/login?oidc_error=link_session`.
- **FR-8.** If the user already has an OIDC identity row (any
  issuer) at callback time, redirect to `/login?oidc_error=
  link_already`.
- **FR-9.** If `(issuer, sub)` already exists and points at a
  *different* user (the rare restoration case), redirect to
  `/login?oidc_error=link_conflict`. Do not overwrite.

### OIDC callback in login mode (unchanged)

- **FR-10.** `findOrCreateOidcUser` is unchanged in this phase.
  It still resolves `(issuer, sub)` to a user, creates a new
  OIDC-provisioned user on miss, recomputes role from groups.
  This is the path the linked user (US-2) and a brand-new SSO
  user traverse.

### `/api/auth/me` informational

- **FR-11.** `GET /api/auth/me` adds an additive
  `linkedMethods: Array<'password' | 'oidc'>` field.
  - `password` is in the array iff `password_hash !== '!oidc!'`
  - `oidc` is in the array iff `user_identities` has ≥ 1 row for
    the user
  The SPA uses this to render `/account` without a second
  round-trip.

### Login UI

- **FR-12.** The login page is unchanged. After Phase 07, when a
  user clicks "Sign in with SSO", the existing OIDC flow handles
  them — including the case where they already have a linked
  identity (FR-10). No new UI on `/login`.

### `/account` page

- **FR-13.** A new SPA route `/account` (gated by `RouteGuard`).
  Renders three panels:
  1. **Account** — username (read-only), role (read-only),
     created-at (read-only).
  2. **Linked accounts** — per FR-1. The SSO panel is hidden
     entirely if OIDC is not configured.
  3. **Change password** — current + new password fields. Calls
     `POST /api/account/password`. (Out of scope to implement in
     this phase unless trivial — see §"Out of scope".)
- **FR-14.** A new `UserMenu` entry "Account" linking to
  `/account` (admin entries remain).
- **FR-15.** `/account?linked=ok` renders a success banner:
  "Single sign-on linked."

### SPA query-param error mapping

- **FR-16.** `?oidc_error=link_session` →
  "Your session expired before linking completed. Sign in again
  and try again."
- **FR-17.** `?oidc_error=link_already` →
  "Single sign-on is already linked to your account."
- **FR-18.** `?oidc_error=link_conflict` →
  "That identity is already linked to another account. Contact
  your administrator."

## Non-functional requirements

- **NFR-1 — Back-compat.** Phase 06 cookies (no `mode` field)
  continue to work; the callback treats them as `mode: 'login'`.
  Existing OIDC-provisioned users log in unchanged. No migration
  required — the schema is sufficient.
- **NFR-2 — Re-auth defence.** Both `/api/account/link/sso/start`
  and `/api/account/link/sso/unlink` require password re-auth,
  not just a session cookie. A stolen browser session is not
  sufficient to bind or unbind SSO. The verify path uses the
  existing `verifyPassword` (constant-time, scrypt).
- **NFR-3 — Race safety.** Two concurrent link attempts for the
  same user hit the `(issuer, sub)` UNIQUE constraint on
  `user_identities`. The link callback catches the constraint
  violation and treats it as success (the first link won).
  Concretely: the second callback sees an existing identity row
  for `(issuer, sub)`, checks it points at the right user
  (FR-9), and redirects to `/account?linked=ok` if so.
- **NFR-4 — Logging.** All link / unlink events log at INFO
  level with `{ event, userId, username, issuer?, sub? }`.
  Failures (bad password, conflict) log at WARN.
- **NFR-5 — Open-redirect guard.** The `next` parameter is still
  validated the same way (already in place).
- **NFR-6 — No new dependencies.** Stdlib + already-installed
  deps only. The link flow reuses the OIDC plumbing from
  Phase 06.
- **NFR-7 — Test discipline.** Per project CLAUDE.md §2.0:
  primary test signal is `./restart.sh` + curl. Vitest covers
  the link/unlink server logic, the state-cookie `mode` field
  round-trip, and the conflict-detection branches.

## Out of scope

- **OOS-1 — Email column / auto-link on first SSO login.** This
  phase uses explicit linking; auto-link by matching email
  would require an `email` column on `users` and is filed for a
  follow-up if a user asks.
- **OOS-2 — OIDC user adding a password.** An OIDC-provisioned
  user (sentinel hash) cannot currently set a password. Adding
  one is straightforward (the sentinel is just a column value)
  but is a separate "Add password to OIDC users" workstream —
  not part of "password users can use SSO".
- **OOS-3 — Multiple IdPs per install / multiple linked
  identities per user across IdPs.** DocKhoj supports one
  OIDC IdP per install (Phase 06). Within one IdP, a user can
  have multiple identity rows if their `sub` changes; we don't
  consolidate.
- **OOS-4 — "Change password" form on /account.** The panel
  renders the form, but `POST /api/account/password` is a
  separate work item — admin password reset already exists
  (Phase 04). Defer until explicitly requested.
- **OOS-5 — Email notifications on link / unlink.** No SMTP
  setup; out of scope per architecture.md's "No SMTP" rule.
- **OOS-6 — Admin-initiated link on behalf of a user.** Admins
  can still delete users; they cannot bind SSO for someone else.
- **OOS-7 — Recovery flow if OIDC_ENABLED is toggled off.** The
  link row sits dormant. Admin can delete it manually.
- **OOS-8 — Per-link audit trail beyond the log line.** No
  `link_events` table; logs are the record.

## Constraints & assumptions

- **C-1.** The current `users.password_hash` is `NOT NULL`.
  No schema migration needed for Phase 07.
- **C-2.** `user_identities.user_id` is `NOT NULL` and FKs to
  `users.id` with `ON DELETE CASCADE`. Linking + unlinking are
  safe under the existing constraints.
- **C-3.** The OIDC state cookie already carries arbitrary JSON
  fields (`state`, `nonce`, `verifier`, `next`, `exp`). Adding
  `mode` and `linkUserId` is a back-compat change.
- **C-4.** There is exactly one OIDC provider per install
  (Phase 06). No multi-provider lookup logic.
- **C-5.** The SPA is same-origin with the API; CSRF risk is
  bounded by `SameSite=Lax` (per architecture.md §"Auth"). The
  link/unlink POSTs are protected by the same `SameSite=Lax`
  cookie + the password re-auth requirement.

## Acceptance criteria

The phase is done when:

- **AC-1.** A password user can navigate to `/account`, click
  "Link single sign-on", re-confirm their password, complete the
  SSO flow, and see "Single sign-on: linked" on `/account`. The
  E2E walkthrough is captured in the fold-in commit message.
- **AC-2.** After linking, the same user can log out, return to
  `/login`, and sign in via the SSO button (without ever
  entering the password again).
- **AC-3.** After linking, the same user can also still sign in
  with username + password. (The two methods are independent.)
- **AC-4.** A user can unlink SSO from `/account`; afterwards
  SSO login fails for that user (the `user_identities` row is
  gone), and password login continues to work.
- **AC-5.** An OIDC-provisioned user (sentinel hash) cannot
  reach `/account`'s "Unlink" button — the server rejects with
  400. (The SPA may not even render the button — both are
  acceptable.)
- **AC-6.** A user who has already linked SSO cannot re-link
  (server returns 409 `already_linked`).
- **AC-7.** A link callback that arrives without a current
  session redirects to `/login?oidc_error=link_session` and
  does NOT create or modify any `user_identities` row.
- **AC-8.** A link callback where `(issuer, sub)` already maps
  to a different user redirects to
  `/login?oidc_error=link_conflict` and does NOT overwrite.
- **AC-9.** All link/unlink events log at INFO; all failures
  log at WARN. The log format is consistent with Phase 06.
- **AC-10.** `./restart.sh` rebuilds cleanly and `/api/health`
  is green after the migration.
- **AC-11.** Vitest suite green; new tests cover: state-cookie
  `mode` round-trip, link/unlink happy path, link-already 409,
  link-conflict 400, unlink-without-password 400.

## Open questions

- **OQ-1.** Should the "Link SSO" button in `/account` require
  the user to type their password, or is a session cookie
  enough? **Working assumption: password required** (NFR-2).
  Pick this if no answer.
- **OQ-2.** Should `findOrCreateOidcUser` recompute role on
  every login when the user is a linked *password* user (not
  OIDC-provisioned)? **Working assumption: yes** — same code
  path (`updateRoleIfChanged`), idempotent, ensures the linked
  user's role tracks their IdP group membership.
- **OQ-3.** Should `/account` also expose "Change password"?
  **Working assumption: render the form but POST handler is
  out of scope** (OOS-4). Confirm at review.
- **OQ-4.** Should the `UserMenu` "Account" entry open a
  dropdown panel or navigate to `/account`? **Working
  assumption: navigate to `/account`** — single click, no
  in-menu state to manage.
- **OQ-5.** Phase 06's `updateRoleIfChanged` is called on every
  SSO login. For a *linked* password user whose local role was
  set by an admin (Phase 04 admin paths), should the IdP
  override? **Working assumption: yes** — IdP is the source of
  truth for group membership; this matches Phase 06's behaviour
  for OIDC-provisioned users.
