import { describe, expect, it } from 'vitest';
import { signState, verifyState, newLoginState, type OidcState } from '../../src/services/oidc';

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
    // Phase 07: verifyState normalizes `mode` onto the return (login
    // when absent), so the round-trip gains that one field.
    expect(parsed).toEqual({ ...s, mode: 'login' });
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
    // ponytail: omit `next` from the signed state; verifyState's shape
    // check should refuse it. (Earlier version accidentally set `s.exp`
    // after the cast — so the state had all 5 fields and the test
    // never actually exercised the missing-field path.)
    const s = { state: 'x', nonce: 'n', verifier: 'v', exp: Date.now() + 60_000 } as unknown as OidcState;
    const cookie = signState(s, SECRET);
    expect(verifyState(cookie, SECRET)).toBeNull();
  });
});

// Phase 07 / p7-T01 — mode + linkUserId extension. Absent mode (Phase 06
// cookies) decodes as 'login'; 'link' requires a linkUserId.
describe('mode + linkUserId (Phase 07)', () => {
  it('decodes a Phase 06 cookie (no mode) as mode=login', () => {
    const cookie = signState(sampleState(), SECRET);
    const parsed = verifyState(cookie, SECRET);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe('login');
    expect(parsed!.linkUserId).toBeUndefined();
  });

  it('round-trips a link-mode state with mode + linkUserId', () => {
    const s: OidcState = { ...sampleState(), mode: 'link', linkUserId: 'user-abc' };
    const cookie = signState(s, SECRET);
    const parsed = verifyState(cookie, SECRET);
    expect(parsed).toEqual({ ...s, mode: 'link', linkUserId: 'user-abc' });
  });

  it('rejects a link-mode state with no linkUserId', () => {
    const s = { ...sampleState(), mode: 'link' } as OidcState;
    const cookie = signState(s, SECRET);
    expect(verifyState(cookie, SECRET)).toBeNull();
  });

  it('rejects a link-mode state with an empty linkUserId', () => {
    const s = { ...sampleState(), mode: 'link', linkUserId: '' } as OidcState;
    const cookie = signState(s, SECRET);
    expect(verifyState(cookie, SECRET)).toBeNull();
  });

  it('coerces an unknown mode value to login', () => {
    const s = { ...sampleState(), mode: 'weird' } as OidcState;
    const cookie = signState(s, SECRET);
    const parsed = verifyState(cookie, SECRET);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe('login');
  });

  it('newLoginState(next) produces a login-mode stateObj', () => {
    const { stateObj } = newLoginState('/chat');
    expect(stateObj.mode).toBeUndefined();
    const cookie = signState(stateObj, SECRET);
    const parsed = verifyState(cookie, SECRET);
    expect(parsed!.mode).toBe('login');
  });

  it('newLoginState(next, { mode, linkUserId }) produces a link-mode stateObj', () => {
    const { stateObj } = newLoginState('/account', { mode: 'link', linkUserId: 'user-xyz' });
    expect(stateObj.mode).toBe('link');
    expect(stateObj.linkUserId).toBe('user-xyz');
    const cookie = signState(stateObj, SECRET);
    const parsed = verifyState(cookie, SECRET);
    expect(parsed!.mode).toBe('link');
    expect(parsed!.linkUserId).toBe('user-xyz');
  });
});