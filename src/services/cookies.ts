import type { FastifyReply } from 'fastify';

// p6-T03: extracted from routes/api-auth.ts. The cookie attribute string
// is the security contract (HttpOnly, SameSite=Lax, Path=/, Max-Age=2592000,
// Secure when NODE_ENV === 'production', per NFR-2). OIDC became the 5th
// caller in phase-06, crossing the YAGNI threshold — the helpers now own
// the attribute set in one place.

export const COOKIE_NAME = 'dockhoj_sid';
export const COOKIE_MAX_AGE = 2592000; // 30 days, per NFR-2.
export const SECURE_COOKIE = process.env.NODE_ENV === 'production';

// p7-T03: OIDC state cookie constants. The state cookie is the short-lived
// (5 min) HMAC-signed carrier for state/nonce/verifier between /login and
// /callback, and now also between /account/link/sso/start and /callback.
// Why centralized: 2 callers (api-auth-oidc + api-account) cross the
// YAGNI threshold for the attribute set, and the cookie name + Max-Age
// must agree with the reader in api-auth-oidc.ts.
export const OIDC_STATE_COOKIE = 'dockhoj_oidc';
export const OIDC_STATE_TTL_SECONDS = 5 * 60;

export function setSessionCookieHeader(reply: FastifyReply, sessionId: string): void {
  const parts = [
    `${COOKIE_NAME}=${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (SECURE_COOKIE) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

export function clearSessionCookieHeader(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0`);
}

export function setOidcStateCookieHeader(reply: FastifyReply, value: string): void {
  const parts = [
    `${OIDC_STATE_COOKIE}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    // ponytail: SameSite=Lax (not Strict) — the IdP's redirect back to
    // /callback is a cross-site top-level GET, and Lax is what carries
    // the cookie on that navigation. Strict would drop it.
    'Path=/',
    `Max-Age=${OIDC_STATE_TTL_SECONDS}`,
  ];
  if (SECURE_COOKIE) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

export function clearOidcStateCookieHeader(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${OIDC_STATE_COOKIE}=; Path=/; Max-Age=0`);
}
