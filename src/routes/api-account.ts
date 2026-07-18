import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import {
  UserStore,
  OIDC_PASSWORD_SENTINEL,
  type User,
} from '../services/user-store.js';
import { UserIdentityStore } from '../services/user-identity-store.js';
import { verifyPassword } from '../services/password.js';
import { setOidcStateCookieHeader } from '../services/cookies.js';
import {
  loadOidcConfig,
  newLoginState,
  buildAuthorizeUrl,
  signState,
} from '../services/oidc.js';
import { log } from '../utils/logger.js';

// p7-T03: /api/account/link/{status,sso/start,sso/unlink}. The auth
// middleware gates everything under /api/* except /api/auth/* and
// /api/health, so request.user is guaranteed populated for these
// routes (see services/auth.ts `isPublic`).
//
// All three routes are JSON in / JSON out (no redirects — the SPA does
// window.location.assign(location) itself for /start). Errors carry a
// sentinel `error` string so the SPA can render the right message.

type DB = Database.Database;

export const accountRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const db = (fastify as unknown as { db: DB }).db;
  const users = new UserStore(db);
  const identities = new UserIdentityStore(db);

  // GET /api/account/link/status — read-only view of the user's linked
  // login methods. The SPA's account page renders the SSO section from
  // this: `password.set=false` means the user is OIDC-only (sentinel
  // hash) and the "unlink SSO" button is hidden.
  fastify.get('/api/account/link/status', async (request, reply) => {
    const user = resolveUser(request, users);
    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }
    const linked = identities.findByUserId(user.id);
    const first = linked[0];
    return {
      password: { set: user.passwordHash !== OIDC_PASSWORD_SENTINEL },
      oidc:
        first !== undefined
          ? { linked: true, issuer: first.issuer, linkedAt: first.createdAt }
          : { linked: false },
    };
  });

  // POST /api/account/link/sso/start — begins the link flow for an
  // already-authenticated password user. Reuses the OIDC /login state
  // machinery (newLoginState + buildAuthorizeUrl) but tags the state
  // cookie with mode='link' + linkUserId so /callback binds the IdP
  // identity to THIS user instead of running find-or-create.
  fastify.post<{ Body: { password?: string } }>(
    '/api/account/link/sso/start',
    async (request, reply) => {
      const user = resolveUser(request, users);
      if (!user) {
        return reply.status(401).send({ error: 'Authentication required' });
      }
      const { password } = request.body ?? {};

      if (user.passwordHash === OIDC_PASSWORD_SENTINEL) {
        return reply.status(400).send({ error: 'Account has no password' });
      }
      if (identities.findByUserId(user.id).length > 0) {
        return reply.status(409).send({ error: 'Single sign-on already linked' });
      }
      if (typeof password !== 'string' || !(await verifyPassword(password, user.passwordHash))) {
        return reply.status(401).send({ error: 'Invalid password' });
      }
      const cfg = loadOidcConfig();
      if (!cfg) {
        return reply.status(503).send({ error: 'OIDC not configured' });
      }

      const { state, nonce, challenge, stateObj } = newLoginState('/account', {
        mode: 'link',
        linkUserId: user.id,
      });
      setOidcStateCookieHeader(reply, signState(stateObj, cfg.clientSecret));
      const location = await buildAuthorizeUrl(cfg, state, nonce, challenge);

      log.info(
        { userId: user.id, event: 'account_link_start', issuer: cfg.issuer },
        'Account link SSO started',
      );
      return reply.status(200).send({ location });
    },
  );

  // POST /api/account/link/sso/unlink — removes all IdP bindings for
  // the user. Single transaction so the delete either fully lands or
  // fully rolls back; the design's invariant is "the user always keeps
  // their password login", so we 400 sentinel-only users up front.
  fastify.post<{ Body: { password?: string } }>(
    '/api/account/link/sso/unlink',
    async (request, reply) => {
      const user = resolveUser(request, users);
      if (!user) {
        return reply.status(401).send({ error: 'Authentication required' });
      }
      const { password } = request.body ?? {};

      if (user.passwordHash === OIDC_PASSWORD_SENTINEL) {
        return reply
          .status(400)
          .send({ error: 'Account has no password; cannot unlink the only login method' });
      }
      if (typeof password !== 'string' || !(await verifyPassword(password, user.passwordHash))) {
        return reply.status(401).send({ error: 'Invalid password' });
      }

      db.transaction(() => {
        identities.unlinkAllForUser(user.id);
      })();

      log.info({ userId: user.id, event: 'account_link_unlink' }, 'Account SSO unlinked');
      return reply.status(200).send({ linkedMethods: ['password'] });
    },
  );
};

/**
 * Resolve request.user → full User row. The auth middleware only
 * populates `{ id, username, role }`; the link routes need the
 * passwordHash too (sentinel check + verifyPassword), so we fetch the
 * row. Returns null if request.user is missing (defensive — the
 * middleware already 401s unauthenticated calls on /api/*) or the
 * underlying user row was deleted mid-session.
 */
function resolveUser(request: FastifyRequest, users: UserStore): User | null {
  if (!request.user) return null;
  return users.findById(request.user.id);
}
