import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

// p4-T04: password hashing.
//
// Implementation note (ponytail): the design commits to argon2id at
// OWASP-recommended parameters, with bcrypt as the documented fallback.
// Neither was available in this worktree's node_modules at T04 time,
// and `npm install` would have corrupted the main checkout's deps
// (the worktree symlinks node_modules to the main project). The
// ponytail-correct rung is "stdlib does it" — Node's `crypto.scrypt`
// is a real password KDF (memory-hard, timingSafeEqual-comparable),
// ships in the box, and needs no native build. Hash format carries an
// algorithm prefix so a future swap to argon2id (or bcrypt) can coexist
// without a schema migration: verify just dispatches on the leading
// tag.
//
// Hash format:  scrypt$<N>$<r>$<p>$<saltB64>$<derivedB64>
//   N, r, p are stored in the hash so verify reproduces the same
//   parameters without consulting a config table. The salt is 16 bytes;
//   the derived key is 64 bytes.
//
// Parameter choice: scrypt's defaults (N=16384, r=8, p=1) — adequate
// for self-hosted scale per the design's threat model, and keeps the
// test suite snappy (~80ms per hash on a modern host). OWASP's
// "strong" scrypt recommendation is N=2^17, which would exceed Node's
// default 32MB maxmem and need a config bump. Flagged here so a
// future hardening pass can ratchet N + maxmem without changing the
// verify path.

const N = 16384;
const R = 8;
const P = 1;
const SALT_LEN = 16;
const KEY_LEN = 64;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(plain.normalize('NFKC'), salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    const parts = hash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [algo, nStr, rStr, pStr, saltB64, derivedB64] = parts as [string, string, string, string, string, string];
    if (algo !== 'scrypt') return false;
    const n = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(derivedB64, 'base64');
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}