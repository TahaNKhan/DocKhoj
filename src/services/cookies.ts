import type { FastifyReply } from 'fastify';

// p6-T03: extracted from routes/api-auth.ts. The cookie attribute string
// is the security contract (HttpOnly, SameSite=Lax, Path=/, Max-Age=2592000,
// Secure when NODE_ENV === 'production', per NFR-2). OIDC became the 5th
// caller in phase-06, crossing the YAGNI threshold — the helpers now own
// the attribute set in one place.

export const COOKIE_NAME = 'dockhoj_sid';
export const COOKIE_MAX_AGE = 2592000; // 30 days, per NFR-2.
export const SECURE_COOKIE = process.env.NODE_ENV === 'production';

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
