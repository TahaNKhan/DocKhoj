import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';
import {
  COOKIE_NAME,
  setSessionCookieHeader,
  setOidcStateCookieHeader,
  clearOidcStateCookieHeader,
  OIDC_STATE_COOKIE,
} from '../services/cookies.js';
import {
  loadOidcConfig,
  getDiscovery,
  getJwks,
  verifyIdToken,
  extractGroups,
  isMember,
  deriveCandidate,
  dedupeUsername,
  verifyState,
  signState,
  newLoginState,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  type OidcConfig,
} from '../services/oidc.js';
import { UserStore, type UserRole, type User } from '../services/user-store.js';
import { AuthSessionStore } from '../services/auth-session-store.js';
import { UserIdentityStore } from '../services/user-identity-store.js';
import { log } from '../utils/logger.js';

type DB = Database.Database;

// p6-T06: /api/auth/oidc/login + /callback. Implements FR-13/14/15/16/17
// (login + callback + session cookie reuse) and the error-handling map
// in design.md §"Error handling strategy".
//
// State is carried in a signed HMAC cookie (`dockhoj_oidc`, OQ-1) —
// stateless, no DB sweep. The cookie is set on /login and cleared on
// /callback (single-use). All errors redirect to `/login?oidc_error=<code>`
// so the SPA can render a message (FR-17 / FR-20); the page-level 503 on
// /login is the only JSON error (operator-misconfig case).

/**
 * Open-redirect guard for the `next` query parameter.
 *
 * ponytail: must be a same-origin relative path. Rejects:
 *   - protocol-relative URLs (`//evil.com`)
 *   - absolute URLs (`https://evil.com`, `http://evil.com`)
 *   - control chars / header injection (`\n`, `\r`)
 *   - anything that doesn't start with `/`
 * On any rejection, coerces to `/chat` (the safe landing page).
 * Mirrors the pattern other handlers in this codebase use; the
 * `next` is then embedded only in the SPA's own redirect, which
 * fastify's `redirect()` honors by Location-header.
 */
function validateNext(next: string | undefined): string {
  if (typeof next !== 'string') return '/chat';
  if (!next.startsWith('/')) return '/chat';
  if (next.startsWith('//')) return '/chat';
  if (next.includes('://')) return '/chat';
  if (/[\n\r]/.test(next)) return '/chat';
  // Reasonable depth limit so a malicious caller can't embed absurdly
  // long paths in the Location header.
  if (next.length > 256) return '/chat';
  return next;
}

/**
 * ponytail: a SQLite UNIQUE-constraint violation surfaces as a
 * better-sqlite3 error with `code === 'SQLITE_CONSTRAINT_UNIQUE'`.
 * The only UNIQUE on user_identities is (issuer, sub), so a hit means
 * another concurrent callback beat us to linking this identity — the
 * "race the design.md anticipates" case.
 */
function isUniqueConstraintError(e: unknown): boolean {
  return (
    !!e &&
    typeof e === 'object' &&
    (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * Resolve the local user for this OIDC identity. Reuses on subsequent
 * logins; creates (sentinel-hashed, no password) on first login.
 *
 * Race handling: if two concurrent callbacks for the same `(issuer, sub)`
 * race past the findUserIdByIssuerSub SELECT, the second one's link()
 * hits the UNIQUE constraint. We catch that and re-fetch — the second
 * callback returns the first one's user. A second local user row is
 * harmless: it has no identity row pointing at it (orphaned) and no
 * password (sentinel), so it can't be used to log in.
 *
 * Role is recomputed on every login (FR-9 — group membership is the
 * source of truth, not the local row's column).
 */
async function findOrCreateOidcUser(
  cfg: OidcConfig,
  users: UserStore,
  identities: UserIdentityStore,
  payload: { sub?: unknown; [k: string]: unknown },
  computedRole: UserRole,
): Promise<User> {
  const sub = String(payload.sub ?? '');
  const issuer = cfg.issuer;
  let userId = identities.findUserIdByIssuerSub(issuer, sub);
  if (userId) {
    const existing = users.findById(userId);
    if (!existing) {
      // ponytail: integrity error — identity row points at a missing
      // user. Could happen if the user was hard-deleted but the FK
      // cascade failed. Surface as 500 rather than silently re-creating.
      throw new Error(`OIDC identity ${issuer}/${sub} points at missing user ${userId}`);
    }
    users.updateRoleIfChanged(userId, computedRole);
    return existing;
  }
  // First login for this identity.
  const candidate = deriveCandidate(payload as Parameters<typeof deriveCandidate>[0]);
  const username = dedupeUsername(candidate, (u) => users.usernameExists(u));
  const newUser = await users.createOidcUser({ username, role: computedRole });
  try {
    identities.link(newUser.id, issuer, sub);
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      // Race lost — another concurrent callback linked first.
      const racerUserId = identities.findUserIdByIssuerSub(issuer, sub);
      if (racerUserId) {
        const racer = users.findById(racerUserId);
        if (racer) {
          users.updateRoleIfChanged(racerUserId, computedRole);
          return racer;
        }
      }
    }
    throw e;
  }
  return newUser;
}

/**
 * ponytail: parsing the dockhoj_oidc cookie by hand mirrors the pattern
 * in api-auth.ts (no @fastify/cookie dep). Kept in sync with the
 * setter above — both sides agree on cookie name + format.
 */
function readOidcStateCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === OIDC_STATE_COOKIE) {
      const v = rest.join('=').trim();
      return v || null;
    }
  }
  return null;
}

/**
 * p7-T02: read the session-cookie sid from the Cookie header. Mirrors
 * readOidcStateCookie — same hand-parse, different cookie name. Used only
 * by the link-mode branch to confirm the caller is already authenticated
 * as the user the state cookie intends to bind the identity to.
 */
function readSessionSid(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      const v = rest.join('=').trim();
      return v || null;
    }
  }
  return null;
}

export const oidcAuthRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const db = (fastify as unknown as { db: DB }).db;
  const users = new UserStore(db);
  const sessions = new AuthSessionStore(db);
  const identities = new UserIdentityStore(db);

  // GET /api/auth/oidc/login?next=<path> → 302 to the IdP (FR-13).
  //
  // 503 JSON when OIDC isn't configured — operators can detect this
  // by hitting /api/auth/status first; the JSON is for programmatic
  // callers, not the SPA flow.
  fastify.get<{ Querystring: { next?: string } }>(
    '/api/auth/oidc/login',
    async (request, reply) => {
      const cfg = loadOidcConfig();
      if (!cfg) {
        log.warn({ event: 'oidc_login_not_configured' }, 'OIDC /login called but not configured');
        return reply.status(503).send({ error: 'OIDC not configured' });
      }
      const next = validateNext(request.query.next);
      const { state, nonce, challenge, stateObj } = newLoginState(next);

      // Sign the state object (state, nonce, verifier, next, exp) and
      // set as a short-lived cookie. The cookie is the only thing
      // carrying verifier+nonce across the IdP redirect; the cookie
      // carries 300s < typical IdP timeout.
      setOidcStateCookieHeader(reply, signState(stateObj, cfg.clientSecret));

      const authUrl = await buildAuthorizeUrl(cfg, state, nonce, challenge);

      log.info({ event: 'oidc_login_started', issuer: cfg.issuer, next }, 'OIDC login started');
      return reply.redirect(authUrl);
    },
  );

  // GET /api/auth/oidc/callback?code=&state= → 302 to /chat (or
  // /login?oidc_error=… on failure). See design.md §"Error handling
  // strategy" for the full error→code map.
  fastify.get<{ Querystring: { code?: string; state?: string } }>(
    '/api/auth/oidc/callback',
    async (request, reply) => {
      const cfg = loadOidcConfig();
      if (!cfg) {
        // ponytail: no config means we can't validate state anyway,
        // so redirect with a generic error — the SPA will render
        // "Sign-in failed" and the operator can fix .env.
        return reply.redirect('/login?oidc_error=config');
      }

      const { code, state: queryState } = request.query;
      const cookieValue = readOidcStateCookie(request.headers.cookie);
      const stored = cookieValue ? verifyState(cookieValue, cfg.clientSecret) : null;

      // Bad state — covers: no cookie, tampered cookie, expired cookie,
      // query state not matching the stored state, or any required
      // field missing in the cookie payload.
      if (!stored || typeof code !== 'string' || code.length === 0) {
        log.warn({ event: 'oidc_state_invalid', hasCookie: !!cookieValue, hasCode: !!code }, 'OIDC callback state invalid');
        return reply.redirect('/login?oidc_error=state');
      }
      if (typeof queryState !== 'string' || queryState !== stored.state) {
        log.warn({ event: 'oidc_state_mismatch' }, 'OIDC callback state mismatch');
        return reply.redirect('/login?oidc_error=state');
      }

      // State is valid — clear the cookie (single-use). Even on
      // subsequent failures below, the cookie is consumed.
      clearOidcStateCookieHeader(reply);

      // Token exchange.
      let tokens;
      try {
        const discovery = await getDiscovery(cfg);
        tokens = await exchangeCodeForToken(cfg, discovery.token_endpoint, code, stored.verifier);
      } catch (err) {
        // ponytail: network-level failure (DNS, connection refused,
        // TLS error). Distinct from a 4xx/5xx response (which returns
        // null) so the operator can see the difference in logs.
        log.error({ err: (err as Error).message, event: 'oidc_token_exchange_failed' }, 'OIDC token exchange network failure');
        return reply.redirect('/login?oidc_error=exchange');
      }
      if (!tokens || typeof tokens.id_token !== 'string') {
        log.warn({ event: 'oidc_token_exchange_bad_response' }, 'OIDC token exchange non-2xx or missing id_token');
        return reply.redirect('/login?oidc_error=exchange');
      }

      // Verify id_token (signature, iss, aud, exp, then manual nonce).
      const discovery = await getDiscovery(cfg);
      const jwks = await getJwks(cfg.discoveryUrl, discovery.jwks_uri);
      let payload;
      try {
        payload = await verifyIdToken(tokens.id_token, jwks, {
          issuer: cfg.issuer,
          audience: cfg.clientId,
          nonce: stored.nonce,
        });
      } catch (err) {
        // ponytail: per design.md §"Error handling strategy", every
        // verification failure collapses to ?oidc_error=token. The
        // detail is logged but never leaked to the SPA — a real
        // attacker gets the same generic message regardless of which
        // check failed.
        log.warn({ err: (err as Error).message, event: 'oidc_id_token_verify_failed' }, 'OIDC id_token verification failed');
        return reply.redirect('/login?oidc_error=token');
      }

      // Group check.
      const groups = extractGroups(payload, cfg.groupsClaim);
      if (!isMember(groups, cfg.allowedGroups)) {
        log.info(
          { sub: payload.sub, issuer: cfg.issuer, event: 'oidc_denied', groupsClaim: cfg.groupsClaim, groupsCount: groups.length },
          'OIDC login denied (not in allowed group)',
        );
        // ponytail: FR-8 says "no user created, no cookie set" — the
        // check runs BEFORE findOrCreate, so this satisfies it. The
        // user might be a legitimate member of a different group; the
        // operator fixes OIDC_ALLOWED_GROUP and they retry.
        return reply.redirect('/login?oidc_error=denied');
      }

      // p7-T02: link-mode branch. The state cookie asked us to bind this
      // (issuer, sub) to an already-authenticated password user instead
      // of running find-or-create. Branches BEFORE the login-mode path;
      // login-mode is structurally unchanged. The group gate above runs
      // for BOTH modes — a denied user in link mode is still denied.
      if (stored.mode === 'link' && stored.linkUserId) {
        const linkUserId = stored.linkUserId;

        // The caller must already hold a session for exactly the user
        // the state cookie names. A missing cookie, no session, or a
        // session for a different user is treated as link_session —
        // the SPA renders "sign in failed" and the user retries.
        const sid = readSessionSid(request.headers.cookie);
        const session = sid ? sessions.findById(sid) : null;
        if (!session || session.userId !== linkUserId) {
          log.warn(
            { event: 'oidc_link_session_missing', linkUserId, hasSid: !!sid },
            'OIDC link-mode callback without matching session',
          );
          return reply.redirect('/login?oidc_error=link_session');
        }

        // Already linked? The link page should have hidden the button,
        // but a stale tab or a replayed state cookie can still get here.
        if (identities.findByUserId(linkUserId).length > 0) {
          log.info(
            { event: 'oidc_link_already', linkUserId },
            'OIDC link-mode callback for user with existing identity',
          );
          return reply.redirect('/login?oidc_error=link_already');
        }

        // Race-safe insert: two concurrent callbacks for the same
        // (issuer, sub) can both pass the findByUserId gate. The UNIQUE
        // constraint on (issuer, sub) is the actual invariant; we catch
        // and reconcile. Same-user race → success (the identity is
        // linked to this user, just by the other callback). Different-
        // user race → link_conflict (the IdP gave two local users the
        // same sub; not something we can recover from here).
        try {
          identities.link(linkUserId, cfg.issuer, String(payload.sub));
        } catch (e) {
          if (isUniqueConstraintError(e)) {
            const racerUserId = identities.findUserIdByIssuerSub(cfg.issuer, String(payload.sub));
            if (racerUserId === linkUserId) {
              // Same-user race — the identity is linked to this user.
              return reply.redirect('/account?linked=ok');
            }
            if (racerUserId) {
              log.warn(
                { event: 'oidc_link_conflict', linkUserId, racerUserId, issuer: cfg.issuer, sub: payload.sub },
                'OIDC link-mode callback: identity already belongs to another user',
              );
              return reply.redirect('/login?oidc_error=link_conflict');
            }
          }
          throw e;
        }

        log.info(
          { event: 'oidc_linked', userId: linkUserId, issuer: cfg.issuer, sub: payload.sub },
          'OIDC identity linked to existing user',
        );
        // No sessions.create, no setSessionCookieHeader — the user
        // already has a session (we verified it above). The state
        // cookie was cleared earlier in the callback; that's the only
        // Set-Cookie we emit in link mode.
        return reply.redirect('/account?linked=ok');
      }

      // Provision + create session.
      const computedRole: UserRole = isMember(groups, cfg.adminGroups) ? 'admin' : 'user';
      let user;
      try {
        user = await findOrCreateOidcUser(cfg, users, identities, payload, computedRole);
      } catch (err) {
        log.error({ err: (err as Error).message, event: 'oidc_provision_failed' }, 'OIDC user provisioning failed');
        return reply.redirect('/login?oidc_error=config');
      }

      const session = sessions.create(user.id);
      users.updateLastLogin(user.id);
      setSessionCookieHeader(reply, session.id);

      log.info(
        { userId: user.id, username: user.username, event: 'oidc_login', role: user.role, issuer: cfg.issuer, sub: payload.sub },
        'OIDC login complete',
      );

      return reply.redirect(stored.next);
    },
  );
};