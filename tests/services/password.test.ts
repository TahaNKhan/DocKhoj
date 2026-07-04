import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/services/password.js';

// p4-T04 tests — password round-trip + invalid-rejection paths.
//
// Coverage:
// - Hash format carries the algorithm prefix + parameters.
// - Same plaintext → same hash (parameter compatible), and verify
//   returns true.
// - Different plaintext → verify returns false.
// - Malformed hashes (wrong prefix, truncated, garbage) → verify
//   returns false without throwing.

describe('password', () => {
  it('produces a hash with the scrypt prefix and parsed parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBeGreaterThan(0); // N
    expect(Number(parts[2])).toBeGreaterThan(0); // r
    expect(Number(parts[3])).toBeGreaterThan(0); // p
    expect(parts[4].length).toBeGreaterThan(0); // salt b64
    expect(parts[5].length).toBeGreaterThan(0); // derived b64
  });

  it('produces a fresh salt on every hash (no two equal hashes for the same password)', async () => {
    const a = await hashPassword('hunter2');
    const b = await hashPassword('hunter2');
    expect(a).not.toBe(b);
  });

  it('verifyPassword returns true for the correct plaintext', async () => {
    const hash = await hashPassword('correcthorse123!');
    expect(await verifyPassword('correcthorse123!', hash)).toBe(true);
  });

  it('verifyPassword returns false for an incorrect plaintext', async () => {
    const hash = await hashPassword('correcthorse123!');
    expect(await verifyPassword('wronghorse123!', hash)).toBe(false);
  });

  it('verifyPassword returns false for an empty plaintext against a real hash', async () => {
    const hash = await hashPassword('correcthorse123!');
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('verifyPassword returns false for a hash with the wrong algorithm prefix', async () => {
    expect(await verifyPassword('whatever', 'argon2id$v=19$m=65536,t=3,p=4$abc$def')).toBe(false);
  });

  it('verifyPassword returns false for a truncated hash', async () => {
    expect(await verifyPassword('whatever', 'scrypt$16384$8$1$abc')).toBe(false);
  });

  it('verifyPassword returns false for a hash with non-numeric parameters', async () => {
    expect(await verifyPassword('whatever', 'scrypt$abc$def$ghi$xxx$yyy')).toBe(false);
  });

  it('verifyPassword returns false for a hash with empty salt', async () => {
    expect(await verifyPassword('whatever', 'scrypt$16384$8$1$$zzz')).toBe(false);
  });

  it('verifyPassword returns false for a hash that is just the prefix', async () => {
    expect(await verifyPassword('whatever', 'scrypt')).toBe(false);
  });

  it('verifyPassword returns false for a totally garbage string', async () => {
    expect(await verifyPassword('whatever', 'not a hash at all')).toBe(false);
  });
});