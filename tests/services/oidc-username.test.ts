import { describe, expect, it } from 'vitest';
import { dedupeUsername, deriveCandidate } from '../../src/services/oidc';
import type { JWTPayload } from 'jose';

// Phase 06 / p6-T05 — username derivation + de-duplication.

describe('deriveCandidate', () => {
  it('prefers preferred_username when it satisfies USERNAME_RE', () => {
    const p: JWTPayload = {
      preferred_username: 'alice',
      email: 'bob@example.com',
      sub: 'abc',
    };
    expect(deriveCandidate(p)).toBe('alice');
  });

  it('falls back to the email local-part when preferred_username is missing', () => {
    const p: JWTPayload = { email: 'alice.k@example.com', sub: 'abc' };
    expect(deriveCandidate(p)).toBe('alice_k'.slice(0, 32).replace(/\W/g, '_'));
    // actual implementation slugifies — see exact expectation below
    expect(deriveCandidate(p)).toBe('alicek');
  });

  it('slugifies the email local-part — strips non [A-Za-z0-9_-] characters', () => {
    const p: JWTPayload = { email: 'a.l.i.c.e+test@example.com', sub: 'abc' };
    expect(deriveCandidate(p)).toBe('alicetest');
  });

  it('falls back to oidc-<sub> when neither preferred_username nor email yields a valid slug', () => {
    const p: JWTPayload = { sub: 'abcdef1234567890xyz' };
    expect(deriveCandidate(p)).toBe('oidc-abcdef1234567890xyz'.slice(0, 32));
  });

  it('sanitizes the sub slug (strips disallowed characters)', () => {
    const p: JWTPayload = { sub: 'a/b:c.d@e+sub' };
    expect(deriveCandidate(p)).toBe('oidc-abcde');
  });

  it('rejects preferred_username that does not satisfy USERNAME_RE', () => {
    const p: JWTPayload = {
      preferred_username: '!!bad!!',
      email: 'alice@example.com',
      sub: 'abc',
    };
    expect(deriveCandidate(p)).toBe('alice');
  });

  it('rejects too-short preferred_username (USERNAME_RE = 3..32)', () => {
    const p: JWTPayload = {
      preferred_username: 'ab',
      email: 'alice@example.com',
      sub: 'abc',
    };
    expect(deriveCandidate(p)).toBe('alice');
  });
});

describe('dedupeUsername', () => {
  it('returns the candidate unchanged when no collision', () => {
    expect(dedupeUsername('alice', () => false)).toBe('alice');
  });

  it('suffixes 2 on first collision, 3 on second, …', () => {
    const taken = new Set(['alice']);
    expect(dedupeUsername('alice', (u) => taken.has(u))).toBe('alice2');
    taken.add('alice2');
    expect(dedupeUsername('alice', (u) => taken.has(u))).toBe('alice3');
  });

  it('strips a trailing digit suffix before re-suffixing (no "alice22")', () => {
    const taken = new Set(['alice2']);
    // User typed "alice2" — we strip the trailing 2 → base "alice" → suffix to "alice3".
    expect(dedupeUsername('alice2', (u) => taken.has(u))).toBe('alice3');
  });

  it('truncates a too-long candidate before suffixing to fit USERNAME_RE 3..32', () => {
    const longName = 'a'.repeat(30);
    expect(dedupeUsername(longName, () => true)).toMatch(/^a+\d+$/);
    // The result must satisfy USERNAME_RE (3..32 chars).
    const result = dedupeUsername(longName, () => true);
    expect(result.length).toBeLessThanOrEqual(32);
  });

  it('falls back to "user" + suffix when the candidate slugifies to empty', () => {
    expect(dedupeUsername('', () => true)).toBe('user2');
  });

  it('handles a saturated namespace by throwing (defensive)', () => {
    // 10000 attempts all collide — verify the function throws rather
    // than spinning forever.
    expect(() => dedupeUsername('x', () => true)).toThrow(/exhausted/);
  });
});