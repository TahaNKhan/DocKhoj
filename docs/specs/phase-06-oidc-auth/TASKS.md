# Phase 06 — TASKS: OIDC (custom provider) login

Task IDs use the project's `p6-T##` convention. Tests land **with** their
task (per global CLAUDE.md §2); each task's acceptance criteria name the
test files it owns. Layers: `data` · `service` · `api` · `spa` · `script` ·
`docs` · `e2e`.

Implementation is driven by the **`phase-swarm`** skill once the workgroups
table below is approved. Each subagent invokes `ponytail` (`full`) before
writing code, marks its task `done` here when acceptance criteria pass, and
commits one task = one commit.

---

## T01 — Migration 008 + `UserIdentityStore` `[data]`

**Desc:** Add the `user_identities` table (migration `008_oidc_identities.sql`)
and a `UserIdentityStore` with `findUserIdByIssuerSub(issuer, sub)` and
`link(userId, issuer, sub)`. The store mirrors the existing `*-store.ts`
convention (snake_case rows → camelCase interface, `datetime('now')`
timestamps).
**Maps to:** FR-10; design §"Data model / Migration 008".
**Acceptance:**
- `008_oidc_identities.sql` present; `UNIQUE(issuer, sub)` index + `user_id` index.
- `UserIdentityStore` compiles; `findUserIdByIssuerSub` returns `string | null`.
- Vitest `user-identity-store.test.ts`: insert→find round-trip; two different
  `sub`s under same `issuer` resolve to different users; cascade delete on
  user removal drops the identity row.
- `./restart.sh` applies 008 cleanly on a fresh volume (migration runner logs it).
**Deps:** none.
**Est:** S.

## T02 — `UserStore.createOidcUser` + `updateRoleIfChanged` + sentinel `[service]`

**Desc:** Add `OIDC_PASSWORD_SENTINEL = '!oidc!'` constant +
`createOidcUser({ username, role })` (inserts with the sentinel, skips
`hashPassword`) and `updateRoleIfChanged(id, role)` to `UserStore`. A `// why:`
comment explains the sentinel (verify fails on the `scrypt$` format check, so
OIDC users structurally can't password-login; avoids a NOT-NULL table rebuild).
**Maps to:** FR-10/12, FR-9; design §"Sentinel password hash (OQ-3)".
**Acceptance:**
- `createOidcUser` inserts a row with `password_hash = '!oidc!'` + given role.
- `verifyPassword(anything, '!oidc!')` returns `false` (regression test in
  `user-store.test.ts` or alongside — the format check rejects it pre-compare).
- `updateRoleIfChanged` issues the UPDATE only when the role actually differs
  (no-op write when unchanged — assert via a spy/count).
**Deps:** T01 (the created user is the one a `user_identities` row points at).
**Est:** S.

## T03 — Extract `cookies.ts` + adopt in `api-auth.ts` `[api]`

**Desc:** Pull `COOKIE_NAME`, `COOKIE_MAX_AGE`, `SECURE_COOKIE`,
`setSessionCookieHeader`, `clearSessionCookieHeader` out of `api-auth.ts`
into `src/services/cookies.ts`. Re-import in `api-auth.ts`. Pure move —
**no behavior change**; the existing `ponytail:` comment (4 = YAGNI threshold)
is updated to note OIDC is the 5th caller, justifying extraction now.
**Maps to:** design §"Module / package layout" (cookies.ts rationale).
**Acceptance:**
- `cookies.ts` exports the 5 symbols; `api-auth.ts` imports them.
- `npm test -- --run` green (existing auth tests unchanged).
- No behavioral diff: login/logout/register/invite-accept set/clear cookies
  identically (covered by existing `api-auth` integration tests).
**Deps:** none (disjoint from T01/T02 files).
**Est:** S.

## T04 — `jose` dep + `setup-oidc` npm script `[infra]`

**Desc:** Add `jose` (^5, MIT) to `dependencies` and `"setup-oidc":
"tsx scripts/setup-oidc.ts"` to `package.json` scripts. One task, one file
(both `package.json` edits) so later tasks don't serialize on it. Run
`npm install` to update the lockfile.
**Maps to:** design §"Tech stack" (jose = only new dep), §"Deployment".
**Acceptance:**
- `package.json` has `jose` in `dependencies` + the `setup-oidc` script.
- `npm install` succeeds; `node_modules/jose` present; `package-lock.json` updated.
- `import { jwtVerify } from 'jose'` resolves (smoke-import in a scratch file
  or the eventual T05).
**Deps:** none.
**Est:** S.

## T05 — `src/services/oidc.ts` (the security core) `[service]`

**Desc:** Create `oidc.ts` with: `loadOidcConfig()` (typed `OidcConfig | null`,
null when off/misconfigured), discovery-doc fetch + in-memory cache, JWKS via
`jose.createRemoteJWKSet`, `verifyIdToken()` (`jose.jwtVerify` with pinned
`algorithms` + `requiredClaims` + manual nonce check), `extractGroups()`,
`deriveCandidate()`/`dedupeUsername()`, `signState()`/`verifyState()` (HMAC
cookie). The HTTP transport (discovery/token/jwks) goes through a thin
injectable `fetch` seam so tests can mock only the network boundary.
**Maps to:** FR-7/8/9/11/13/14/15; NFR-1/2/3/5; design §"Key algorithms/flows"
(config, discovery+JWKS, id_token verify, groups, username, state cookie).
**Acceptance:**
- Module compiles; `loadOidcConfig` returns null with `OIDC_ENABLED` unset/false.
- `extractGroups` handles array / csv-string / missing / mixed-type;
  `isMember` honors blank-gate-passes + case-sensitivity.
  → `oidc-groups.test.ts`.
- `deriveCandidate` preference order (`preferred_username`→email-local→`oidc-<sub>`)
  + `dedupeUsername` suffixing (`alice`→`alice2`→`alice3`).
  → `oidc-username.test.ts`.
- `signState`/`verifyState` round-trip + tamper-reject + expiry-reject.
  → `oidc-state.test.ts`.
- `verifyIdToken` accepts a real `jose.SignJWT`-signed token; rejects tampered
  sig, wrong `iss`/`aud`, expired `exp`, mismatched `nonce`.
  → `oidc-verify.test.ts` (integration; RSA keypair generated in-test).
**Deps:** T04 (jose).
**Est:** L.

## T06 — `routes/api-auth-oidc.ts` + register in `index.ts` `[api]`

**Desc:** Implement `GET /api/auth/oidc/login` (PKCE + state cookie + 302 to
IdP) and `GET /api/auth/oidc/callback` (state check → token exchange →
`verifyIdToken` → group gate → find-or-create in one transaction →
`updateRoleIfChanged` → session cookie → 302 to validated `next`). All errors
302 to `/login?oidc_error=<code>`. Register the plugin in `index.ts`. Use
`cookies.ts` (T03) for the session cookie.
**Maps to:** FR-13/14/15/16/17; design §"API surface" (login, callback),
§"Find-or-create + role recompute", §"Error handling strategy".
**Acceptance:**
- `/login` sets `dockhoj_oidc` cookie + 302 to `authorization_endpoint` with
  PKCE params when OIDC enabled; 503 JSON when misconfigured.
- Happy-path inject: forged-good state cookie + real-signed id_token →
  `dockhoj_sid` set, user + identity created, 302 to `/chat`.
- Group denial → no identity row, no cookie, 302 `?oidc_error=denied`.
- Bad state / token / exchange → correct `oidc_error` code, no session.
- `next` validation rejects open-redirect (`//evil`, `https://…`) → coerces `/chat`.
  → `api-auth-oidc.test.ts` (integration, `fastify.inject`, mocked IdP fetch).
- `./restart.sh` boots with the route registered.
**Deps:** T05 (oidc.ts), T02 (createOidcUser), T01 (identity store), T03 (cookies.ts).
**Est:** L.

## T07 — `/api/auth/status` `oidc` field `[api]`

**Desc:** Extend the `/status` handler to return `oidc: { enabled, providerName }`
alongside the existing `firstUserAvailable`. `enabled` from `loadOidcConfig()`;
`providerName` = `OIDC_PROVIDER_NAME` or the issuer host.
**Maps to:** FR-19; design §"API surface (/status)".
**Acceptance:**
- With OIDC off: `{ firstUserAvailable, oidc: { enabled: false, providerName: '' } }`.
- With OIDC on: `enabled: true`, `providerName` populated.
- Existing `/status` callers/tests still pass (additive field).
  → extend `api-auth.test.ts`.
**Deps:** T03 (same file `api-auth.ts` — serialize), T05 (loadOidcConfig).
**Est:** S.

## T08 — SPA `auth.ts` status type `[spa]`

**Desc:** Extend `fetchAuthStatus` return type with the `oidc` field
(`{ enabled: boolean; providerName: string }`).
**Maps to:** FR-19; design §"Module / package layout (web/src/services/auth.ts)".
**Acceptance:**
- Type compiles; `fetchAuthStatus` returns the new shape; default-safe when
  the field is absent (older server) — treat missing `oidc` as `enabled:false`.
**Deps:** T07 (API contract).
**Est:** S.

## T09 — SPA `Login.tsx` SSO button + `?oidc_error` render + `auth.css` `[spa]`

**Desc:** On `/login`, when `status.oidc.enabled`, render a "Sign in with
&lt;Provider&gt;" button (full-nav to `/api/auth/oidc/login?next=…`) below the
password form. Render an inline `auth-error` when `?oidc_error=<code>` is
present (map `state|exchange|token|denied` → friendly text). Add button styles
to `auth.css` reusing existing tokens (`.auth-sso`, divider `.auth-or`).
**Maps to:** FR-18/20; design §"Login flow (SPA)".
**Acceptance:**
- Button hidden when `oidc.enabled === false`; shown with provider name when true.
- `?oidc_error=denied` renders the denial message; other codes render generic.
- No console errors; matches light/dark tokens; keyboard-accessible (it's an `<a>`/`<button>`).
**Deps:** T08 (status type).
**Est:** M.

## T11 — `src/services/dotenv-rewrite.ts` (pure `.env` rewriter) `[service]`

**Desc:** Pure `rewriteEnvFile(content: string, updates: Record<string,string>):
string` that appends new keys, replaces existing keys **in place**, preserves
all other lines + comments, and guarantees exactly one trailing newline.
No `dotenv` dep (the file is hand-curated). Reusable by the setup script.
**Maps to:** FR-5; NFR-7; design §"Tech stack (.env rewrite)", §"setup script".
**Acceptance:** → `dotenv-rewrite.test.ts`:
- append new key (no prior);
- replace existing in place (line position preserved);
- preserve unrelated lines + comments + blank lines;
- blank value (`KEY=`) handled;
- single trailing newline; stable line order.
**Deps:** none.
**Est:** S.

## T12 — `scripts/setup-oidc.ts` (the 4-step interactive setup) `[script]`

**Desc:** UC-1's four steps: (1) prompt base URL → print redirect URI;
(2) pause for IdP client creation; (3) prompt discovery URL → fetch + validate
`{issuer, authorization_endpoint, token_endpoint, jwks_uri}` → prompt client
id/secret + allowed group + admin group + groups claim + provider name;
(4) confirm → write `.env` via `rewriteEnvFile`. Matches
`reset-admin-account.ts` conventions (`node:readline`, ANSI-on-TTY, argv
flags for `--non-interactive`). Secret hidden on entry, never echoed.
**Maps to:** FR-1/2/3/4/5/6; NFR-4/6/7; design §"The setup script".
**Acceptance:**
- `npm run setup-oidc` runs the four steps; writes only OIDC keys; other
  `.env` lines byte-preserved (assert via a `diff` in a scripted test or manual
  acceptance — the unit coverage is `rewriteEnvFile` in T11).
- Refuses missing/invalid `APP_BASE_URL`; warns on `http://`.
- Argv flags (`--base-url`, `--discovery-url`, `--client-id`, `--client-secret`,
  `--allowed-group`, `--admin-group`, `--groups-claim`, `--provider-name`,
  `--non-interactive`) drive a non-interactive run.
- Idempotent: re-run updates OIDC keys in place.
**Deps:** T11 (rewriteEnvFile), T04 (script entry).
**Est:** M.

## T13 — `.env.example` OIDC section + README touch `[docs]`

**Desc:** Document every `OIDC_*` var + `APP_BASE_URL` in `.env.example`
(with the disabled-by-default master toggle) and add a "Single sign-on (OIDC)"
subsection to `README.md` pointing at `npm run setup-oidc`. These are
user-facing entry points (a new command + new env section) — fold-in
candidates per the skill's Step 7.
**Maps to:** FR-6; design §"Deployment / runtime (env vars)".
**Acceptance:**
- `.env.example` has a commented OIDC block listing all 11 vars + defaults.
- `README.md` mentions `setup-oidc` and the OIDC login option.
**Deps:** none (logically late; land after the code is stable).
**Est:** S.

## T14 — E2E walkthrough: `./restart.sh` + curl (disabled-default path) `[e2e]`

**Desc:** The project's integration bar (per `CLAUDE.md`). With OIDC disabled
(default `.env`): `/api/auth/status` → `oidc.enabled=false`; password login
unchanged; `/api/auth/oidc/login` returns the disabled/503 handler; the SPA
hides the SSO button. Then a documented **manual** acceptance run of UC-1/UC-3
against a real IdP (not automatable in CI without a live provider).
**Maps to:** requirements §"Acceptance criteria"; design §"Testing strategy (E2E)".
**Acceptance:**
- `./restart.sh` green; `curl /api/auth/status` shows the `oidc` field.
- `npm test -- --run` fully green (no `.skip`).
- Disabled-default surface behaves as specified; manual IdP walkthrough
  documented in the commit body (or a `**Manual:**` note here if deferred).
**Deps:** T06, T07, T09, T12, T13 (everything wired).
**Est:** S.

---

## Dependency graph

| Task | Depends on | Blocks | Est | Layer |
|---|---|---|---|---|
| T01 | — | T02, T06 | S | data |
| T02 | T01 | T06 | S | service |
| T03 | — | T06, T07 | S | api |
| T04 | — | T05, T12 | S | infra |
| T05 | T04 | T06, T07 | L | service |
| T06 | T01, T02, T03, T05 | T14 | L | api |
| T07 | T03, T05 | T08 | S | api |
| T08 | T07 | T09 | S | spa |
| T09 | T08 | T14 | M | spa |
| T11 | — | T12 | S | service |
| T12 | T04, T11 | T14 | M | script |
| T13 | — | T14 | S | docs |
| T14 | T06, T07, T09, T12, T13 | — | S | e2e |

## Parallel workgroups

> Two tasks are parallelizable iff they share no files. Files each task
> touches are listed so the reader can confirm the diffs don't overlap.

| Gate | Parallel tasks (disjoint files) |
|---|---|
| **Gate 0** (no deps) | T01 (`008_*.sql`, `user-identity-store.ts`) ∥ T03 (`cookies.ts`, `api-auth.ts`) ∥ T04 (`package.json`) ∥ T11 (`dotenv-rewrite.ts`) |
| After **T01 + T04** | T02 (`user-store.ts`) ∥ T05 (`oidc.ts`) |
| After **T02 + T03 + T05 + T11** | T06 (`api-auth-oidc.ts`, `index.ts`) ∥ T07 (`api-auth.ts`) ∥ T12 (`setup-oidc.ts`) ∥ T13 (`.env.example`, `README.md`) |
| After **T07** | T08 (`web/services/auth.ts`) |
| After **T08** | T09 (`Login.tsx`, `auth.css`) |
| After **T06 + T07 + T09 + T12 + T13** | T14 (e2e, no source edits) |

**Same-file constraint honored:** the only file touched by two tasks is
`api-auth.ts` (T03 extracts, T07 adds the `oidc` field) — sequenced T03 → T07.
Every other gate lists genuinely disjoint diffs.

## Critical path

The longest dependent chain — where wall-clock lives. Everything branching
off it is free parallelism.

```
T04 → T05 → T07 → T08 → T09 → T14   (6 nodes)
```

- `T04` (jose) gates `T05` (oidc.ts) — the security core.
- `T05` gates `T07` (`/status` field), which gates the SPA chain `T08 → T09`.
- `T09` gates `T14` (the button must exist before the e2e can assert it's hidden/shown).

`T06` (the callback) is the same-gate peer of `T07` and is the highest-risk
task, but it's **not** on the critical path: it feeds `T14` directly without
a downstream chain. `T01 → T02 → T06` is a shorter 3-node branch off the
critical path at `T05`. Schedule `T06` first inside its gate so its risk
burns down in parallel with the trivial SPA chain.

---

## Status legend

- `[ ]` todo · `[~]` in-progress · `[x]` done · `[!]` blocked
- Update a task's status (and add `**Notes:**` / `**Blocker:**` lines) in the
  same commit that implements it, per global CLAUDE.md §9.

<!-- Status block — keep in sync with per-task checkboxes above. -->
- T01 `[x]` · T02 `[x]` · T03 `[x]` · T04 `[x]` · T05 `[x]` · T06 `[x]`
- T07 `[x]` · T08 `[ ]` · T09 `[ ]` · T11 `[x]` · T12 `[x]` · T13 `[x]` · T14 `[ ]`

## Gate log

- **Gate 0** (done 2026-07-18): T01, T03, T04, T11 merged into main.
  579 passed / 7 skipped (+16 tests); the 21 web/happy-dom errors are a
  pre-existing worktree-bootstrap gap, present on main before phase-06.
  Worktrees cleaned up.

- **Gate 1** (done 2026-07-18): T02 + T05 merged into main. Verification
  surfaced six real bugs in T05's tests that the prior commit deferred
  ("verification deferred to phase end per env constraint"): jose v5
  doesn't export `randomState`/`randomNonce`/`randomPKCECodeVerifier`/
  `calculatePKCECodeChallenge` (used by `newLoginState`), jose's
  `createRemoteJWKSet` ignores a custom fetch (used by tests), and four
  test-side bugs in the username / state / signature-tamper tests.
  Fixed on the T05 branch as one commit (p6-T05: fix verify/username/
  state test bugs); 40 OIDC tests now pass reliably across 10 runs.
  72 OIDC + user-store tests on main.

- **Gate 2** (done 2026-07-18): T06, T07, T12, T13 merged into main.
  T06 is the meat — `/api/auth/oidc/login` + `/callback` with PKCE,
  state-cookie, real JOSE id_token verification, group denial, find-
  or-create, role recompute, open-redirect guard. 23 new tests in
  `tests/routes/api-auth-oidc.test.ts`. T07 extended `/api/auth/status`
  with the additive `oidc` field — required also updating two existing
  assertions in `api-auth.test.ts` to use `objectContaining` (one
  follow-up commit). T12 is the operator-facing `setup-oidc.ts` (398
  lines; untested in CI, will be exercised via the manual acceptance
  step in T14). T13 is the docs touch (.env.example + README). 651
  passed / 7 skipped on main (+72 over Gate 1).
  ./restart.sh + curl: OIDC routes registered; /login → 503 JSON when
  OIDC off; /callback → 302 /login?oidc_error=config when OIDC off;
  existing auth routes unchanged.
