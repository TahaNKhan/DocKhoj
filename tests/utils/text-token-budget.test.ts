import { describe, it, expect } from 'vitest';
import { countTokens, truncateToTokenBudget } from '../../src/utils/text-token-budget.js';

// Phase 03 / p3-T07 — token budget helper. Uses cl100k_base (same
// tokenizer the chunker uses), so budgets are comparable across the
// pipeline.

describe('countTokens', () => {
  it('counts the empty string as 0', () => {
    expect(countTokens('')).toBe(0);
  });

  it('counts a short ASCII string as at least 1 token', () => {
    const n = countTokens('hello');
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThan(5);
  });

  it('produces monotonically non-decreasing counts as input grows', () => {
    const a = countTokens('a');
    const b = countTokens('aa');
    const c = countTokens('aaaa');
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
  });

  it('counts unicode at the right scale', () => {
    // 100 emojis — well above what 100 ASCII chars would tokenize to.
    const n = countTokens('😀'.repeat(100));
    expect(n).toBeGreaterThan(20);
  });
});

describe('truncateToTokenBudget', () => {
  it('returns empty string for budget <= 0', () => {
    expect(truncateToTokenBudget('hello world', 0)).toBe('');
    expect(truncateToTokenBudget('hello world', -5)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(truncateToTokenBudget('', 10)).toBe('');
  });

  it('returns the original text when it already fits', () => {
    const text = 'a short string';
    expect(truncateToTokenBudget(text, 100)).toBe(text);
  });

  it('truncates when input exceeds budget', () => {
    const text = 'the quick brown fox jumps over the lazy dog '.repeat(50);
    const truncated = truncateToTokenBudget(text, 10);
    expect(truncated.length).toBeLessThan(text.length);
    // Round-trip: the truncated string should fit the budget.
    expect(countTokens(truncated)).toBeLessThanOrEqual(10);
  });

  it('preserves UTF-8 content through the encode/decode round-trip', () => {
    const text = 'héllo wörld — emoji 😀 and multi-byte 中文字符';
    const truncated = truncateToTokenBudget(text, 100);
    expect(truncated.length).toBeLessThanOrEqual(text.length);
    // No replacement chars from a botched decode.
    expect(truncated).not.toContain('�');
  });

  it('does not return more tokens than the budget', () => {
    const text = 'lorem ipsum '.repeat(500);
    const budget = 25;
    const out = truncateToTokenBudget(text, budget);
    expect(countTokens(out)).toBeLessThanOrEqual(budget);
  });
});