# Phase 06 — Requirements: OIDC (custom provider) login

## Purpose

DocKhoj's only login mechanism today is local username + password (Phase 04).
This phase adds an **additive** login path: single sign-on with a
**user-configured OpenID Connect (OIDC) provider** — e.g. Keycloak, Authelia,
Authentik, Okta, Dex, Zitadel, or any compliant OIDC IdP. OIDC sits
**alongside** the password form; existing users keep working unchanged.

The operator configures the provider through an interactive setup script that
discovers the endpoints automatically, so wiring up a new provider is a few
prompts, not a hunt through `.env`. The script writes only the OIDC keys into
`.env`, leaving every other config untouched.

## Users / actors

- **End user** — has an account at the IdP. Wants one-click "Sign in with
  &lt;Provider&gt;" and no second password to remember.
- **Operator (the person running DocKhoj)** — registers DocKhoj as a client at
  the IdP, runs the setup script, sets which IdP groups may access DocKhoj and
  which group grants admin. Wants a setup that does not require editing a
  dozen env vars by hand.
- **Admin user** — local DocKhoj role (`role = 'admin'`); still manages
  invites / users via the existing admin routes. The OIDC admin-group mapping
  is a *separate* way to gain the role, not a replacement for local admins.

## Use cases

### UC-1 — Operator wires up a new IdP (the four-step script)
1. Operator runs `npm run setup-oidc`. Script asks for the **app base URL**
   (where DocKhoj is reachable, e.g. `https://dockhoj.example.com`) and prints
   the exact **redirect URI** to register at the IdP
   (`<base>/api/auth/oidc/callback`).
2. Operator creates a client at the IdP (paste the redirect URI, copy the
   issued client id + secret).
3. Operator resumes the script: enters the **OIDC discovery URL**
   (`.well-known/openid-configuration`), the **client id**, and the **client
   secret**. The script fetches the discovery document, validates that the
   required endpoints exist, and shows a summary.
4. Operator confirms; the script appends **only the OIDC keys** to `.env`
   (never rewriting or deleting unrelated lines). If OIDC keys already exist,
   they are **replaced** in place; everything else stays byte-for-byte.

### UC-2 — Operator sets the access + admin groups
The script (or a follow-up prompt) lets the operator set:
- `OIDC_ALLOWED_GROUP` — IdP group(s) that may log in. Users **without** this
  group are refused at the callback (403).
- `OIDC_ADMIN_GROUP` — IdP group that maps to DocKhoj `role = 'admin'`.
  Members of this group get admin; everyone else who passes the access check
  gets `role = 'user'`.

Either may be a single value or a comma-separated list. A **blank allowed
group means "no group gate"** (anyone the IdP accepts can log in) — the
default for a quick first setup.

### UC-3 — End user signs in via OIDC
1. On `/login`, the user sees the existing password form **plus** a
   "Sign in with &lt;Provider&gt;" button (the provider name comes from the
   discovery document's `issuer`/display, or the client id if unnamed).
2. Clicking it redirects to the IdP's authorization endpoint with PKCE
   (`S256`) and the configured scopes (`openid profile email groups`).
3. After authenticating at the IdP, the browser is redirected to
   `/api/auth/oidc/callback?code=…&state=…`.
4. DocKhoj exchanges the code for tokens, verifies the id_token (signature,
   issuer, audience, expiry, nonce), reads the groups claim, and:
   - If the user is **not** in the allowed group → 403.
   - Else **finds-or-creates** the local DocKhoj user (see "Provisioning"
     below) and sets the `dockhoj_sid` session cookie — exactly the same
     cookie as password login. The user is then redirected to the SPA
     (`/chat`, or the `?next=` target).

### UC-4 — Operator reconfigures or disables OIDC
Re-running `npm run setup-oidc` updates the keys in place. To disable OIDC,
the operator removes the `OIDC_*` keys from `.env` (the script offers to do
this); the "Sign in with" button disappears and only password login remains.

## Functional requirements

> FR IDs are `p6-TNN`-independent here (FR-1…FR-N); tasks in `TASKS.md`
> reference these IDs.

### Discovery / configuration

- **FR-1.** A script at `scripts/setup-oidc.ts`, runnable via
  `npm run setup-oidc`, implements UC-1's four steps.
- **FR-2.** Step 1: prompt for **base URL**, validate it parses as an
  `http(s)://…` URL with no trailing path collisions, and print the redirect
  URI `<base>/api/auth/oidc/callback` with instructions to register it.
- **FR-3.** Step 3: prompt for the **discovery URL** and fetch its
  `.well-known/openid-configuration`. Validate that the document exposes
  `issuer`, `authorization_endpoint`, `token_endpoint`, and
  `jwks_uri`. If any is missing, fail fast with a clear message.
- **FR-4.** Step 3: prompt for **client id** and **client secret** (secret
  typed hidden where the terminal supports it).
- **FR-5.** Step 4: write the OIDC keys into `.env` **additively**:
  - Keys that don't exist are appended.
  - Keys that already exist are **replaced in place** (value updated, line
    position preserved).
  - Lines that are not OIDC keys (comments, other config) are **untouched**.
  - The file ends with exactly one trailing newline.
- **FR-6.** The OIDC keys written are:
  `OIDC_ENABLED`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
  `OIDC_DISCOVERY_URL`, `OIDC_SCOPES`, `OIDC_ALLOWED_GROUP`,
  `OIDC_ADMIN_GROUP`. (Plus `APP_BASE_URL` for redirect-URI construction at
  runtime.)

### Group gates

- **FR-7.** `OIDC_ALLOWED_GROUP` may be blank (no gate), a single group, or a
  comma-separated list. Membership = claim value matches any entry
  (case-sensitive, trimmed).
- **FR-8.** At the callback, a user **not** in the allowed group is refused
  with HTTP 403 and a plain message; no local user is created and no cookie
  is set.
- **FR-9.** `OIDC_ADMIN_GROUP` maps members to `role = 'admin'`; non-members
  that pass the access check get `role = 'user'`. This is **recomputed on
  every login** (a user removed from the admin group loses admin on next
  login; a user added gains it).

### Provisioning (find-or-create)

- **FR-10.** The local DocKhoj user is resolved by a stable identity, not by
  username. A new `user_identities` table links `users.id ↔ (provider, sub)`.
  First login with a given `(issuer, sub)` creates the local user; subsequent
  logins reuse it.
- **FR-11.** The local **username** is derived from the id_token's
  `preferred_username` (fallback `email` local-part, fallback `sub`) and
  **de-duplicated** — if the candidate collides with an existing local
  username, a numeric suffix is appended (`alice`, `alice2`, `alice3` …)
  until unique. The collision check honours the existing
  `^[A-Za-z0-9_-]{3,32}$` rule; candidates that cannot be made compliant
  fall back to a generated slug.
- **FR-12.** OIDC-provisioned users store **no password hash** (the column
  is nullable in this phase, or a sentinel `!oidc!` placeholder is stored —
  decided in design). Password login for such accounts is impossible by
  construction.

### Login flow (server)

- **FR-13.** `GET /api/auth/oidc/login?next=<path>` starts a login: generates
  PKCE verifier + challenge (`S256`) and a `state`/`nonce`, stores them in a
  short-lived signed cookie (or a server-side row, decided in design),
  302-redirects to `authorization_endpoint` with `response_type=code`,
  `scope`, `client_id`, `redirect_uri`, `state`, `nonce`,
  `code_challenge`, `code_challenge_method=S256`.
- **FR-14.** `GET /api/auth/oidc/callback` accepts the `code` + `state`,
  validates `state` (CSRF), exchanges the code at `token_endpoint` with the
  PKCE verifier (client secret in the body, `client_secret_basic` also
  supported — decided in design), and receives `{id_token, access_token?, ...}`.
- **FR-15.** The **id_token is verified**: signature against the **JWKS**
  (fetched from `jwks_uri`, cached, refreshed on key-not-found), `iss == issuer`,
  `aud` contains `client_id`, `exp` not past, `nonce` matches the one from
  FR-13. Any failure → 401 with a generic message (no detail leakage).
- **FR-16.** After verification + group checks, the existing cookie-session
  machinery is reused: a row is created in `auth_sessions` and the
  `dockhoj_sid` cookie is set with the **same attributes** as password login
  (HttpOnly, SameSite=Lax, Path=/, Max-Age=30d, Secure in production).
- **FR-17.** The callback redirects to the SPA: `/chat` (or the validated
  `next`). On any error it redirects to `/login?oidc_error=<code>` so the
  SPA can render a message.

### Login flow (SPA)

- **FR-18.** When `OIDC_ENABLED=true`, `/login` shows a "Sign in with
  &lt;Provider&gt;" button below the password form. Clicking it does a full
  navigation to `/api/auth/oidc/login?next=<current next>`.
- **FR-19.** `/api/auth/status` gains an `oidc` field
  (`{ enabled: bool, providerName: string }`) so the SPA can render the
  button without hardcoding config.
- **FR-20.** A `?oidc_error=` query on `/login` renders an inline error
  ("Sign-in with &lt;Provider&gt; failed: &lt;message&gt;").

### Security / non-functional

- **NFR-1 (PKCE).** Every authorization uses PKCE `S256`; the verifier never
  leaves the server. Required even though we have a client secret — defence
  in depth against intercepted authorization codes.
- **NFR-2 (state + nonce).** `state` (CSRF) and `nonce` (replay) are
  cryptographically random, single-use, bound to the transaction, and
  short-lived (≤5 min).
- **NFR-3 (id_token verification).** Per FR-15. **The id_token signature is
  verified against the IdP's JWKS** — never trusted by decoding alone.
- **NFR-4 (no secret leakage).** The client secret lives only in `.env`
  (gitignored) and server memory; it is never sent to the SPA, never logged,
  never echoed by the setup script after entry.
- **NFR-5 (group-claim name is configurable).** Different IdPs put groups in
  `groups`, `member_of`, `roles`, a namespaced claim, etc. The claim path is
  configurable via `OIDC_GROUPS_CLAIM` (default `groups`). The script lets
  the operator inspect a sample token's claims to pick the right one.
- **NFR-6 (HTTPS in production).** OIDC redirects + cookies require HTTPS in
  production (already a standing rule from Phase 04); the setup script warns
  if the base URL is `http://` in a production-looking deploy.
- **NFR-7 (idempotent setup).** Running `setup-oidc` twice is safe; it
  updates the OIDC keys in place and leaves the rest of `.env` intact
  (per FR-5).
- **NFR-8 (no new runtime deps unless justified).** Prefer `node:crypto` +
  `fetch` (Node 20 has global `fetch` + `crypto.subtle`/`createPublicKey`).
  A small, well-scoped dep (e.g. `jose` for JWKS + JWT verification) is
  allowed only if hand-rolling the JOSE bits is materially larger; the
  decision is made in `design.md` via the ponytail ladder.
- **NFR-9 (audit logging).** OIDC login / creation / group-rejection are
  logged via the existing `pino` logger (no PII beyond username; never the
  token).

## Out of scope

- **OIDC logout / single-logout (SLO).** Logging out of DocKhoj ends the
  DocKhoj session; it does **not** call the IdP's `end_session_endpoint`.
  Future work.
- **Refresh tokens / token storage.** We exchange the code, verify the
  id_token, and discard the tokens. We do **not** persist access/refresh
  tokens or call userinfo on every request. Session lifetime is governed by
  DocKhoj's cookie session, not the IdP's tokens.
- **Multiple IdPs simultaneously.** One OIDC provider per install in this
  phase. The `user_identities` table is provider-aware so a future phase can
  add a second without a migration.
- **Group claim synchronization for existing users.** Role is recomputed
  only at login time. We do not poll the IdP.
- **Admin UI for editing OIDC config.** OIDC config is `.env`-only; the
  setup script is the editor.
- **Replacing password login.** Out of scope — this phase is additive.

## Constraints & assumptions

- Node 20 runtime (global `fetch`, `crypto.subtle`, `createPublicKey` for
  JWKS verification). Matches the project's existing Node 20 floor.
- `.env` is a flat `KEY=VALUE` file; the project does not use a nested env
  schema. The setup script must parse/rewrite it without a dotenv library
  (the existing `.env.example` is hand-curated).
- SQLite is the persistence layer; new table(s) ship as migration `008_*.sql`,
  following the existing hand-rolled runner.
- The existing cookie-session model (Phase 04) is reused as-is; OIDC only
  changes **how** the user row is resolved, not how the session works.
- IdP supports standard OIDC authorization-code + PKCE. (All the providers
  named in "Purpose" do.)

## Acceptance criteria

- `npm run setup-oidc` runs UC-1 end to end against a real IdP and writes
  exactly the OIDC keys to `.env`, leaving other lines unchanged (verified
  by a `diff` of the file before/after a non-OIDC line is added).
- With OIDC enabled, `/login` shows the SSO button; clicking it completes a
  real login against a real IdP and lands the user on `/chat` with a valid
  `dockhoj_sid` cookie.
- A user **without** the allowed group is refused (403) at the callback and
  no local user is created.
- A user **in** the admin group has `role = 'admin'` after login (visible in
  `/api/auth/me`); removing them from the group and logging in again flips
  them to `user`.
- Repeated logins of the same IdP user reuse the same local user row (no
  duplicates); the `user_identities` table has exactly one row per
  `(issuer, sub)`.
- Password login still works unchanged for pre-existing local accounts.
- A tampered `state`/`nonce`, an expired id_token, or a wrong-audience
  id_token is rejected (401) — no session created.
- `./restart.sh` + `curl` protocol (per `CLAUDE.md`) stays green: the OIDC
  callback route is registered, `/api/auth/status` returns the `oidc` field,
  and the existing `/api/*` surface is unaffected.
- Unit/integration tests cover the parts awkward to hit via curl against a
  real IdP: state/PKCE generation, id_token verification (good + tampered +
  wrong-issuer + wrong-audience + expired), group-membership logic, username
  de-duplication, and the `.env` rewrite (replace-in-place + preserve-other-lines).

## Open questions

- **OQ-1.** PKCE/state/nonce store: signed short-lived cookie vs. a new
  server-side `oidc_login_states` table. Design decides (ponytail: signed
  cookie is stateless and avoids a DB sweep; but a table is easier to
  invalidate).
- **OQ-2.** Client auth at the token endpoint: `client_secret_basic`
  (Authorization header) vs `client_secret_post` (body). Some IdPs accept
  only one. Design picks a default (post, with basic as fallback) and notes
  the configurable.
- **OQ-3.** Whether to store a sentinel password hash for OIDC users
  (`password_hash` is `NOT NULL` today) or alter the column to nullable.
  Design decides (nullable is the clean fix; sentinel avoids a migration
  risk).
- **OQ-4.** Should the setup script let the operator paste a **raw id_token
  sample** to auto-detect the groups-claim path, or only accept the claim
  name as a prompt? (FR / NFR-5 imply the prompt; the auto-detect is a
  convenience stretch.)
