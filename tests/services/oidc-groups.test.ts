import { describe, expect, it } from 'vitest';
import { extractGroups, isMember } from '../../src/services/oidc';
import type { JWTPayload } from 'jose';

// Phase 06 / p6-T05 — group extraction + membership.

describe('extractGroups', () => {
  it('reads a string-array claim and trims each entry', () => {
    const p: JWTPayload = { groups: ['admins', '  devs  ', 'users'] };
    expect(extractGroups(p, 'groups')).toEqual(['admins', 'devs', 'users']);
  });

  it('reads a comma-separated string claim', () => {
    const p: JWTPayload = { groups: 'admins, devs , users' };
    expect(extractGroups(p, 'groups')).toEqual(['admins', 'devs', 'users']);
  });

  it('returns an empty array when the claim is missing (fail-closed)', () => {
    const p: JWTPayload = {};
    expect(extractGroups(p, 'groups')).toEqual([]);
  });

  it('returns an empty array when the claim is a non-string non-array (fail-closed)', () => {
    expect(extractGroups({ groups: 42 }, 'groups')).toEqual([]);
    expect(extractGroups({ groups: { admins: true } }, 'groups')).toEqual([]);
    expect(extractGroups({ groups: null }, 'groups')).toEqual([]);
  });

  it('filters non-string entries out of an array claim', () => {
    const p = { groups: ['admins', 42, null, 'devs', true] } as unknown as JWTPayload;
    expect(extractGroups(p, 'groups')).toEqual(['admins', 'devs']);
  });

  it('honors a configurable claim path', () => {
    expect(extractGroups({ member_of: ['a'] }, 'member_of')).toEqual(['a']);
    expect(extractGroups({ 'https://idp/roles': ['r'] }, 'https://idp/roles')).toEqual(['r']);
  });

  it('returns an empty array for a blank csv string', () => {
    expect(extractGroups({ groups: '   ,  ,  ' }, 'groups')).toEqual([]);
  });
});

describe('isMember', () => {
  it('passes through when allowed is empty (no-gate default)', () => {
    expect(isMember([], [])).toBe(true);
    expect(isMember(['anything'], [])).toBe(true);
  });

  it('returns true when any group matches', () => {
    expect(isMember(['a', 'b', 'c'], ['b'])).toBe(true);
    expect(isMember(['a', 'b'], ['x', 'b'])).toBe(true);
  });

  it('returns false when no group matches', () => {
    expect(isMember(['a', 'b'], ['x', 'y'])).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isMember(['Admin'], ['admin'])).toBe(false);
    expect(isMember(['admin'], ['Admin'])).toBe(false);
  });

  it('matches exactly (no substring)', () => {
    expect(isMember(['admins'], ['admin'])).toBe(false);
    expect(isMember(['admin'], ['admins'])).toBe(false);
  });
});