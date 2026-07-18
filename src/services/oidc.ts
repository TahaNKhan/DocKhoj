// Phase 06 / p6-T05: OIDC security core.
//
// Single module that owns OIDC configuration loading, OIDC discovery-doc
// caching, JWKS resolution (via jose), id_token verification (PKCE, state,
// nonce, signature, iss/aud/exp/iat — every check pinned), group
// extraction + membership, username derivation + de-duplication, and the
// HMAC-signed state cookie used to carry (state, nonce, verifier, next)
// from /login → /callback without server-side storage.
//
// This module is the security boundary for OIDC. Everything that is
// "just env-reading" goes through `loadOidcConfig()`; everything that
// reaches the IdP goes through `_fetch` (overridable for tests).
//
// Per phase-06 design.md §"Key algorithms/flows". Each function maps to
// one algorithm block in the design; the tests in tests/services/oidc-*
// cover each block in isolation with real crypto (jose.SignJWT-signed
// tokens, RSA keypair generated in-test). The IdP HTTP transport is the
// only thing mocked — at the network boundary per project CLAUDE.md §2.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createLocalJWKSet,
  jwtVerify,
  type JWTPayload,
  type KeyLike,
  type JWSHeaderParameters,
} from 'jose';
import { log } from '../utils/logger.js';

// ── Config loading ──────────────────────────────────────────────────────

export interface OidcConfig {
  /** Public client id issued by the IdP. */
  clientId: string;
  /** Client secret used at the token endpoint. */
  clientSecret: string;
  /** Expected `iss` claim on id_tokens. From the discovery doc's issuer. */
  issuer: string;
  /** .well-known/openid-configuration URL the operator pasted in. */
  discoveryUrl: string;
  /** Space-separated scope string (default "openid profile email groups"). */
  scopes: string;
  /** JWT claim path to read group memberships from. */
  groupsClaim: string;
  /** Operator-configured access gate. Empty array = no gate. */
  allowedGroups: string[];
  /** Operator-configured admin-role mapping. Empty array = none. */
  adminGroups: string[];
  /** Display name for the SSO button (issuer host if unset). */
  providerName: string;
  /** How to authenticate at the token endpoint. */
  tokenAuthMethod: 'client_secret_post' | 'client_secret_basic';
  /** Fully-qualified callback URL — APP_BASE_URL + '/api/auth/oidc/callback'. */
  redirectUri: string;
}

const DEFAULT_SCOPES = 'openid profile email groups';
const DEFAULT_GROUPS_CLAIM = 'groups';

/**
 * ponytail: one typed object, computed once per call from env. Returns
 * null when OIDC is off OR misconfigured — the rest of the app treats null
 * as "no OIDC", so a half-configured install degrades to password-only
 * instead of crashing logins.
 */
export function loadOidcConfig(): OidcConfig | null {
  const enabled = (process.env.OIDC_ENABLED ?? '').toLowerCase() === 'true';
  if (!enabled) return null;

  const clientId = process.env.OIDC_CLIENT_ID ?? '';
  const clientSecret = process.env.OIDC_CLIENT_SECRET ?? '';
  const issuer = process.env.OIDC_ISSUER ?? '';
  const discoveryUrl = process.env.OIDC_DISCOVERY_URL ?? '';
  const baseUrl = process.env.APP_BASE_URL ?? '';

  if (!clientId || !clientSecret || !issuer || !discoveryUrl || !baseUrl) {
    // One env var missing is operator error — surface it once so the
    // operator can fix .env instead of getting an opaque 401 at login.
    log.warn(
      { hasClientId: !!clientId, hasSecret: !!clientSecret, hasIssuer: !!issuer, hasDiscoveryUrl: !!discoveryUrl, hasBaseUrl: !!baseUrl },
      'OIDC_ENABLED=true but required env vars are missing — falling back to password-only',
    );
    return null;
  }

  const csvToArr = (raw: string | undefined): string[] =>
    (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  return {
    clientId,
    clientSecret,
    issuer,
    discoveryUrl,
    scopes: process.env.OIDC_SCOPES ?? DEFAULT_SCOPES,
    groupsClaim: process.env.OIDC_GROUPS_CLAIM ?? DEFAULT_GROUPS_CLAIM,
    allowedGroups: csvToArr(process.env.OIDC_ALLOWED_GROUP),
    adminGroups: csvToArr(process.env.OIDC_ADMIN_GROUP),
    providerName: process.env.OIDC_PROVIDER_NAME ?? hostOfIssuer(issuer),
    tokenAuthMethod:
      process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD === 'client_secret_basic'
        ? 'client_secret_basic'
        : 'client_secret_post',
    redirectUri: baseUrl.replace(/\/+$/, '') + '/api/auth/oidc/callback',
  };
}

function hostOfIssuer(issuer: string): string {
  try {
    return new URL(issuer).host || 'SSO';
  } catch {
    return 'SSO';
  }
}

// ── Discovery + JWKS caching ────────────────────────────────────────────

export interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface CachedDiscovery {
  doc: DiscoveryDoc;
  fetchedAt: number;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h
let discoveryCache: CachedDiscovery | null = null;

const JWKS_CACHE = new Map<string, ReturnType<typeof import('jose').createLocalJWKSet>>();

// ponytail: a module-level fetch seam so tests can inject a fake transport
// without monkey-patching globalThis.fetch. The real `fetch` is the Node 20
// global. setFetchForTesting() resets it. The seam is the *only* network
// surface in this module — everything else is pure.
let _fetch: typeof fetch = (...args) => fetch(...args);

export function setFetchForTesting(f: typeof fetch): void {
  _fetch = f;
}

export function resetFetchForTesting(): void {
  _fetch = (...args) => fetch(...args);
}

async function fetchDiscovery(discoveryUrl: string): Promise<DiscoveryDoc> {
  if (discoveryCache && discoveryCache.fetchedAt + DISCOVERY_TTL_MS > Date.now()) {
    return discoveryCache.doc;
  }
  const res = await _fetch(discoveryUrl);
  if (!res.ok) {
    discoveryCache = null;
    throw new Error(`OIDC discovery fetch failed: HTTP ${res.status}`);
  }
  const doc = (await res.json()) as Partial<DiscoveryDoc>;
  // ponytail: fail fast on a missing required endpoint — otherwise we
  // surface a confusing error three requests later at the token endpoint.
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC discovery doc missing required endpoints (issuer/authorization_endpoint/token_endpoint/jwks_uri)');
  }
  const full = doc as DiscoveryDoc;
  discoveryCache = { doc: full, fetchedAt: Date.now() };
  return full;
}

export async function getDiscovery(cfg: OidcConfig): Promise<DiscoveryDoc> {
  return fetchDiscovery(cfg.discoveryUrl);
}

export async function getJwks(discoveryUrl: string, jwksUri: string): Promise<ReturnType<typeof createLocalJWKSet>> {
  const cached = JWKS_CACHE.get(discoveryUrl);
  if (cached) return cached;
  // ponytail: jose v5's createRemoteJWKSet doesn't honor a custom fetch
  // option (it uses globalThis.fetch internally), so tests can't mock
  // the network boundary there. We fetch the JWKS ourselves via the
  // injectable `_fetch` seam and hand jose a LocalJWKSet — same
  // signature-verify path, but no hidden network calls. Trade-off: we
  // lose jose's per-kid cooldown cache, but the JWKS doc is small and
  // infrequent (one verification per login), so a per-process in-memory
  // cache is enough.
  return fetchJwksLocal(discoveryUrl, jwksUri);
}

async function fetchJwksLocal(
  discoveryUrl: string,
  jwksUri: string,
): Promise<ReturnType<typeof import('jose').createLocalJWKSet>> {
  const res = await _fetch(jwksUri);
  if (!res.ok) {
    throw new Error(`OIDC JWKS fetch failed: HTTP ${res.status}`);
  }
  const doc = (await res.json()) as { keys: unknown[] };
  if (!Array.isArray(doc.keys)) {
    throw new Error('OIDC JWKS doc missing `keys` array');
  }
  const localJwks = createLocalJWKSet(doc as Parameters<typeof createLocalJWKSet>[0]);
  JWKS_CACHE.set(discoveryUrl, localJwks);
  return localJwks;
}

/** Test seam: forget every cached entry. */
export function resetCachesForTesting(): void {
  discoveryCache = null;
  JWKS_CACHE.clear();
}

// ── id_token verification (FR-15 / NFR-3) ───────────────────────────────

/**
 * Algorithms we accept for id_token signatures. ponytail: literal union
 * rather than a type alias because jose v5 doesn't export `JWS_ALG`
 * (every algorithm is its own literal type). Pinned for alg-confusion
 * defense (NFR-3) — never allow 'none'.
 */
const ALLOWED_ALGS: Array<JWSHeaderParameters['alg']> = [
  'RS256', 'RS384', 'RS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
  'PS256', 'PS384', 'PS512',
];

export interface VerifyOptions {
  issuer: string;
  audience: string;
  nonce: string;
}

/**
 * Verify an id_token's signature + claims + nonce.
 * Throws on any failure (the caller maps to `?oidc_error=token`).
 *
 * The `jwks` arg accepts either a LocalJWKSet (built once per process
 * via `getJwks`, which fetches via our injectable `_fetch` so tests
 * can mock the network boundary) or a single key for unit tests.
 */
export async function verifyIdToken(
  token: string,
  jwks: ReturnType<typeof createLocalJWKSet> | KeyLike | Uint8Array,
  opts: VerifyOptions,
): Promise<JWTPayload> {
  // ponytail: `as never` because jose's overload signatures disagree on
  // what a "key resolver" looks like (one overload accepts a function,
  // another wants the concrete key). At runtime the value is one of the
  // types we declared in the parameter list; the cast is purely to
  // satisfy the union-of-overloads inference.
  const { payload } = await jwtVerify(token, jwks as never, {
    issuer: opts.issuer,
    audience: opts.audience,
    algorithms: ALLOWED_ALGS as never,
    requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'],
  });
  // jose does not enforce nonce (it's an app-specific transaction-binding
  // value), so check it manually after jose's structural checks pass.
  if (typeof payload.nonce !== 'string' || payload.nonce !== opts.nonce) {
    throw new Error('OIDC nonce mismatch');
  }
  return payload;
}

// ── Group extraction + membership (FR-7/8/9 / NFR-5) ────────────────────

/**
 * Read the configured groups claim from a verified id_token payload.
 * Coerces the common shapes (string array, comma-separated string) and
 * fails closed — a missing or wrongly-shaped claim yields an empty array,
 * which is denied by an active access gate.
 */
export function extractGroups(payload: JWTPayload, claim: string): string[] {
  const v = payload[claim];
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim());
  }
  if (typeof v === 'string') {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Case-sensitive membership check. An empty `allowed` list passes
 * through (the "no access gate configured" default).
 */
export function isMember(groups: string[], allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((g) => groups.includes(g));
}

// ── Username derivation + de-duplication (FR-11) ────────────────────────

// why: duplicated from user-store.ts rather than re-exported — the
// USERNAME_RE is a 1-line constant and re-exporting it just to share
// across two files buys nothing.
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

/**
 * Derive a local username from the id_token payload.
 * Preference: preferred_username → email local-part → oidc-<sub>.
 */
export function deriveCandidate(payload: JWTPayload): string {
  const preferred = payload.preferred_username;
  if (typeof preferred === 'string' && USERNAME_RE.test(preferred)) {
    return preferred;
  }
  const email = payload.email;
  if (typeof email === 'string') {
    const local = email.split('@')[0] ?? '';
    const slug = local.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    if (USERNAME_RE.test(slug)) return slug;
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const subSlug = sub.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 26);
  const fallback = 'oidc-' + subSlug;
  // Ensure the fallback itself respects USERNAME_RE — if the slug is too
  // short after sanitization, pad to the minimum length.
  if (fallback.length >= 3 && USERNAME_RE.test(fallback)) return fallback;
  return 'oidc-' + 'user'.slice(0, 26);
}

/**
 * Pick a unique local username starting from `candidate`. On collision,
 * append 2, 3, … until `exists(u)` is false. Truncates `candidate` to
 * leave room for the suffix if needed.
 */
export function dedupeUsername(candidate: string, exists: (u: string) => boolean): string {
  if (USERNAME_RE.test(candidate) && !exists(candidate)) return candidate;
  // Strip trailing digits from a candidate like "alice2" → "alice" so we
  // don't end up with "alice22" (re-collision). Then rebuild.
  const base = candidate.replace(/\d+$/, '').slice(0, 29) || 'user';
  for (let i = 2; i < 10000; i++) {
    const candidate2 = `${base}${i}`;
    if (USERNAME_RE.test(candidate2) && !exists(candidate2)) return candidate2;
  }
  // Vanishingly unlikely — the loop only exits when the namespace is
  // saturated, which 10000 collisions would imply.
  throw new Error('dedupeUsername: exhausted suffix namespace');
}

// ── State cookie (OQ-1 — signed HMAC, stateless) ────────────────────────

export interface OidcState {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  /** Epoch ms — the cookie is rejected after this. */
  exp: number;
  /**
   * Phase 07 — what the callback should do with this identity. Absent
   * (Phase 06 cookies) is treated as `'login'`. `'link'` binds the
   * IdP identity to an already-authenticated password user instead of
   * running find-or-create.
   */
  mode?: 'login' | 'link';
  /** Present iff `mode === 'link'`. The local user the identity binds to. */
  linkUserId?: string;
}

const STATE_TTL_MS = 5 * 60 * 1000;
const STATE_KEY_NAMESPACE = 'dockhoj-oidc-state-v1';

function stateKey(secret: string): Buffer {
  return createHmac('sha256', STATE_KEY_NAMESPACE).update(secret).digest();
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Build the cookie value: base64url(JSON(state)) + '.' + base64url(HMAC).
 * HMAC is over the payload (everything before the '.'), keyed with an HMAC
 * derived from the client secret — rotating the secret invalidates all
 * in-flight state cookies (acceptable; user retries).
 */
export function signState(state: OidcState, clientSecret: string): string {
  const payload = JSON.stringify(state);
  const payloadB64 = b64url(payload);
  const sig = createHmac('sha256', stateKey(clientSecret)).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

/** Returns the parsed state, or null on tamper, expiry, or malformed cookie. */
export function verifyState(cookie: string, clientSecret: string): OidcState | null {
  const dot = cookie.indexOf('.');
  if (dot <= 0 || dot === cookie.length - 1) return null;
  const payloadB64 = cookie.slice(0, dot);
  const sigB64 = cookie.slice(dot + 1);

  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = createHmac('sha256', stateKey(clientSecret)).update(payloadB64).digest();
    provided = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  let parsed: OidcState;
  try {
    parsed = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as OidcState;
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.state !== 'string' ||
    typeof parsed.nonce !== 'string' ||
    typeof parsed.verifier !== 'string' ||
    typeof parsed.next !== 'string' ||
    typeof parsed.exp !== 'number'
  ) {
    return null;
  }
  if (parsed.exp <= Date.now()) return null;

  // Phase 07 — coerce the new optional fields. An absent `mode` (Phase 06
  // cookies) decodes as `'login'` so old cookies keep working. `link`
  // requires a non-empty `linkUserId` or the cookie is malformed.
  const mode: 'login' | 'link' = parsed.mode === 'link' ? 'link' : 'login';
  const linkUserId =
    typeof parsed.linkUserId === 'string' && parsed.linkUserId.length > 0
      ? parsed.linkUserId
      : undefined;
  if (mode === 'link' && !linkUserId) return null;

  return { ...parsed, mode, linkUserId };
}

/**
 * ponytail: PKCE + state + nonce are all just URL-safe random bytes hashed
 * once for the challenge. We use node:crypto (rung 3) rather than jose's
 * PKCE helpers — jose v5 doesn't export `randomState`/`randomNonce`/
 * `randomPKCECodeVerifier`/`calculatePKCECodeChallenge`, and a 1-line
 * `randomBytes().toString('base64url')` covers both sides of the wire.
 *
 *   state    = 32 random bytes, base64url       (CSRF)
 *   nonce    = 32 random bytes, base64url       (replay)
 *   verifier = 32 random bytes, base64url       (PKCE; 43-128 chars per RFC 7636)
 *   challenge = base64url(SHA-256(verifier))   (PKCE S256)
 */
function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Helper for /login (and /account/link/sso/start): build a fresh state
 * object with state/nonce/verifier/challenge.
 *
 * ponytail: one helper, optional 2nd arg, rather than a parallel
 * `newLinkState`. The 1-arg call shape is unchanged from Phase 06;
 * passing `link` embeds `mode: 'link'` + `linkUserId` so the callback
 * binds the IdP identity to the already-authenticated password user.
 */
export function newLoginState(
  next: string,
  link?: { mode: 'link'; linkUserId: string },
): { state: string; nonce: string; verifier: string; challenge: string; stateObj: OidcState } {
  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const verifier = randomBase64Url(32);
  const challenge = pkceS256(verifier);
  const base = { state, nonce, verifier, next, exp: Date.now() + STATE_TTL_MS };
  const stateObj: OidcState = link
    ? { ...base, mode: 'link', linkUserId: link.linkUserId }
    : base;
  return { state, nonce, verifier, challenge, stateObj };
}

/**
 * Build the IdP `/authorize` URL with PKCE + state + nonce. Phase 07
 * lifts this out of the callback route so the new `/account/link/sso/start`
 * route reuses it; Phase 06 had one caller (the inline build didn't justify
 * the abstraction then). Pure function over `cfg` + the freshly-generated
 * values from `newLoginState`.
 */
export async function buildAuthorizeUrl(
  cfg: OidcConfig,
  state: string,
  nonce: string,
  challenge: string,
): Promise<string> {
  const discovery = await getDiscovery(cfg);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', cfg.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ── Token exchange ──────────────────────────────────────────────────────

export interface TokenExchangeResult {
  id_token: string;
  access_token?: string;
}

/**
 * Exchange an authorization code for tokens at the IdP's token endpoint.
 *
 * Supports both `client_secret_post` (secret in form body — default) and
 * `client_secret_basic` (HTTP Basic — set via `OIDC_TOKEN_ENDPOINT_AUTH_METHOD`
 * for IdPs that require it). Returns null on non-2xx; throws on network
 * failure (caller catches and reports `?oidc_error=exchange`).
 *
 * Routes through the injectable `_fetch` seam so tests can mock only the
 * network boundary. The wire format is the standard OIDC form-encoded body.
 */
export async function exchangeCodeForToken(
  cfg: OidcConfig,
  tokenEndpoint: string,
  code: string,
  verifier: string,
): Promise<TokenExchangeResult | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (cfg.tokenAuthMethod === 'client_secret_basic') {
    headers.Authorization =
      'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  } else {
    body.set('client_secret', cfg.clientSecret);
  }
  const res = await _fetch(tokenEndpoint, { method: 'POST', headers, body });
  if (!res.ok) return null;
  return (await res.json()) as TokenExchangeResult;
}