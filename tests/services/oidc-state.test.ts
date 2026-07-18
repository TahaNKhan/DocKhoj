import { describe, expect, it } from 'vitest';
import { signState, verifyState, type OidcState } from '../../src/services/oidc';

// Phase 06 / p6-T05 — HMAC state cookie (sign/verify round-trip + tamper/expiry/malformed).

const SECRET = 'test-client-secret-abc123';
function sampleState(exp?: number): OidcState {
  return {
    state: 'statevalue',
    nonce: 'noncevalue',
    verifier: 'verifiervalue',
    next: '/chat',
    exp: exp ?? Date.now() + 60_000,
  };
}

describe('signState + verifyState', () => {
  it('round-trips a freshly-signed state', () => {
    const s = sampleState();
    const cookie = signState(s, SECRET);
    const parsed = verifyState(cookie, SECRET);
    expect(parsed).toEqual(s);
  });

  it('rejects a tampered payload (sig no longer matches)', () => {
    const s = sampleState();
    const cookie = signState(s, SECRET);
    // Flip one byte in the payload — modify the base64url first char.
    const tampered = (cookie[0] === 'A' ? 'B' : 'A') + cookie.slice(1);
    expect(verifyState(tampered, SECRET)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const s = sampleState();
    const cookie = signState(s, SECRET);
    const dot = cookie.lastIndexOf('.');
    const tampered = cookie.slice(0, dot + 1) + 'AAAA' + cookie.slice(dot + 5);
    expect(verifyState(tampered, SECRET)).toBeNull();
  });

  it('rejects an expired state', () => {
    const s = sampleState(Date.now() - 1000);
    const cookie = signState(s, SECRET);
    expect(verifyState(cookie, SECRET)).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    const s = sampleState();
    const cookie = signState(s, SECRET);
    expect(verifyState(cookie, 'different-secret')).toBeNull();
  });

  it('rejects a malformed cookie (no dot)', () => {
    expect(verifyState('nodot', SECRET)).toBeNull();
  });

  it('rejects a malformed cookie (dot at edge)', () => {
    expect(verifyState('.foo', SECRET)).toBeNull();
    expect(verifyState('foo.', SECRET)).toBeNull();
  });

  it('rejects a state with a missing required field', () => {
    const s = { state: 'x', nonce: 'n', verifier: 'v', next: '/chat' } as unknown as OidcState;
    s.exp = Date.now() + 60_000;
    const cookie = signState(s, SECRET);
    expect(verifyState(cookie, SECRET)).toBeNull();
  });
});