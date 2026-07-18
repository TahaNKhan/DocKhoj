import { describe, expect, it } from 'vitest';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from 'jose';
import { verifyIdToken } from '../../src/services/oidc';

// Phase 06 / p6-T05 — id_token verification with real crypto.
//
// We mint tokens in-test with jose.SignJWT using an RSA keypair we
// generated ourselves, and feed jose a createLocalJWKSet wrapper so
// jose's verification path is identical to production (same kid/key
// resolution, same signature algorithm support) without hitting any
// network. This is the "mock at the network boundary" approach: the
// crypto is real, the HTTP transport is what would be mocked.

const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'dockhoj-client';

interface KeyMaterial {
  // ponytail: jose's generateKeyPair returns KeyObject in Node and
  // CryptoKey in browsers; exportJWK handles both. crypto.subtle.exportKey
  // throws on a Node KeyObject — we hit that here before this fix.
  privateKey: CryptoKey | Uint8Array;
  publicJwk: JWK;
}

async function makeKey(): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey: privateKey as unknown as CryptoKey,
    publicJwk: { ...jwk, kid: 'test-kid-1', alg: 'RS256', use: 'sig' },
  };
}

async function mintToken(
  km: KeyMaterial,
  overrides: {
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    nonce?: string;
    extraClaims?: Record<string, unknown>;
    tamper?: 'sig' | 'none';
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    sub: 'user-sub-1',
    groups: ['users'],
    preferred_username: 'alice',
    ...(overrides.extraClaims ?? {}),
    // ponytail: include nonce in the constructor's claims object — the
    // SignJWT copies them at construction time, so a later `claims.nonce =`
    // has no effect. Earlier version did the assignment after `new SignJWT`
    // and the verify step rejected the token for "OIDC nonce mismatch".
    ...(overrides.nonce !== undefined ? { nonce: overrides.nonce } : {}),
  };
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid-1' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .setSubject('user-sub-1')
    .setJti(`jti-${now}`);
  let token = await jwt.sign(km.privateKey);

  if (overrides.tamper === 'sig') {
    // ponytail: flipping the last base64url char is often a no-op — the
    // last 2 bits of the final char are padding bits ignored on decode.
    // Decode to bytes, flip a real byte, re-encode. This guarantees the
    // decoded signature changes. (~1-in-2^8 chance the flipped byte
    // happens to be the byte jose ignores, but that's vanishing.)
    const segs = token.split('.');
    const sigB64 = segs[2] ?? '';
    const sigBytes = Buffer.from(sigB64, 'base64url');
    sigBytes[0] = (sigBytes[0]! ^ 0x01) & 0xff;
    token = `${segs[0]}.${segs[1]}.${sigBytes.toString('base64url')}`;
  }
  return token;
}

describe('verifyIdToken', () => {
  it('accepts a valid RS256 id_token (real signature, real key)', async () => {
    const km = await makeKey();
    const localJwks = createLocalJWKSet({ keys: [km.publicJwk] });
    const token = await mintToken(km, { nonce: 'nonce-a' });
    const payload = await verifyIdToken(token, localJwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: 'nonce-a',
    });
    expect(payload.sub).toBe('user-sub-1');
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(AUDIENCE);
    expect(payload.nonce).toBe('nonce-a');
  });

  it('rejects a token with a tampered signature', async () => {
    const km = await makeKey();
    const localJwks = createLocalJWKSet({ keys: [km.publicJwk] });
    const token = await mintToken(km, { nonce: 'nonce-a', tamper: 'sig' });
    await expect(
      verifyIdToken(token, localJwks, { issuer: ISSUER, audience: AUDIENCE, nonce: 'nonce-a' }),
    ).rejects.toThrow();
  });

  it('rejects a token with the wrong issuer', async () => {
    const km = await makeKey();
    const localJwks = createLocalJWKSet({ keys: [km.publicJwk] });
    const token = await mintToken(km, { nonce: 'nonce-a', issuer: 'https://evil.example.com' });
    await expect(
      verifyIdToken(token, localJwks, { issuer: ISSUER, audience: AUDIENCE, nonce: 'nonce-a' }),
    ).rejects.toThrow();
  });

  it('rejects a token with the wrong audience', async () => {
    const km = await makeKey();
    const localJwks = createLocalJWKSet({ keys: [km.publicJwk] });
    const token = await mintToken(km, { nonce: 'nonce-a', audience: 'some-other-client' });
    await expect(
      verifyIdToken(token, localJwks, { issuer: ISSUER, audience: AUDIENCE, nonce: 'nonce-a' }),
    ).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const km = await makeKey();
    const localJwks = createLocalJWKSet({ keys: [km.publicJwk] });
    const token = await mintToken(km, { nonce: 'nonce-a', expiresIn: '-1s' });
    await expect(
      verifyIdToken(token, localJwks, { issuer: ISSUER, audience: AUDIENCE, nonce: 'nonce-a' }),
    ).rejects.toThrow();
  });

  it('rejects a token with a mismatched nonce', async () => {
    const km = await makeKey();
    const localJwks = createLocalJWKSet({ keys: [km.publicJwk] });
    // Sign with one nonce, verify expecting another — jose's structural
    // checks pass (sig/iss/aud/exp are fine), our manual nonce check
    // throws.
    const token = await mintToken(km, { nonce: 'nonce-a' });
    await expect(
      verifyIdToken(token, localJwks, { issuer: ISSUER, audience: AUDIENCE, nonce: 'nonce-b' }),
    ).rejects.toThrow(/nonce/);
  });

  it('rejects a token signed by a key not in the JWKS', async () => {
    const signer = await makeKey();
    const trusted = await makeKey(); // different key
    const localJwks = createLocalJWKSet({ keys: [trusted.publicJwk] });
    const token = await mintToken(signer, { nonce: 'nonce-a' });
    await expect(
      verifyIdToken(token, localJwks, { issuer: ISSUER, audience: AUDIENCE, nonce: 'nonce-a' }),
    ).rejects.toThrow();
  });
});