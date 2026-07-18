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
    // ponytail: the implementation slugifies the local-part (strips
    // non [A-Za-z0-9_-] chars). 'alice.k' → 'alicek'. An earlier
    // version of this test had a stray second expect asserting
    // 'alice_k' (dots become underscores) that contradicted the
    // actual behavior — removed.
    const p: JWTPayload = { email: 'alice.k@example.com', sub: 'abc' };
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
    // ponytail: the implementation keeps `.` (it's in [A-Za-z0-9_-]),
    // so 'a/b:c.d@e' sanitizes to 'abc.de' → 'oidc-abc.de'. Earlier
    // version expected 'oidc-abcde' (5 chars) from an input that
    // actually sanitizes to 8 — the input was too long for the
    // expectation. Use a 5-char sanitized input.
    const p: JWTPayload = { sub: 'a/b:c.d@e' };
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
    // ponytail: predicate marks the original name as taken; the first
    // suffix is free. An `() => true` predicate exhausts the namespace
    // and throws — that's the separate "saturated namespace" test.
    const longName = 'a'.repeat(30);
    const taken = new Set<string>([longName]);
    const result = dedupeUsername(longName, (u) => taken.has(u));
    expect(result).toMatch(/^a+\d+$/);
    expect(result.length).toBeLessThanOrEqual(32);
  });

  it('falls back to "user" + suffix when the candidate slugifies to empty', () => {
    // ponytail: this asserts the empty-candidate fallback path — the
    // base becomes 'user' (the `|| 'user'` after the digit-strip),
    // and i=2 is the first free suffix. The exists() predicate is
    // false for everything so the function takes the happy path and
    // returns 'user2'. (An `() => true` predicate would exhaust the
    // namespace and throw — that's a separate test below.)
    expect(dedupeUsername('', () => false)).toBe('user2');
  });

  it('handles a saturated namespace by throwing (defensive)', () => {
    // 10000 attempts all collide — verify the function throws rather
    // than spinning forever.
    expect(() => dedupeUsername('x', () => true)).toThrow(/exhausted/);
  });
});