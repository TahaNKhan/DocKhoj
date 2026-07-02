import { describe, it, expect } from 'vitest';
import { createThinkFilter } from '../../src/utils/think-filter.js';

// p3-T15 — the think filter was previously leaking stray </think>
// tags without an opener into the streamed text. These tests pin the
// fixed behavior and the existing matched-pair behavior together so
// neither regresses.

const OPEN = '<think>';
const CLOSE = '</think>';

describe('createThinkFilter', () => {
  it('passes plain text through unchanged', () => {
    const f = createThinkFilter();
    expect(f.push('Hello world.')).toBe('Hello world.');
    expect(f.flush()).toBeNull();
  });

  it('strips a complete think block in a single push', () => {
    const f = createThinkFilter();
    expect(f.push(`x${OPEN}secret${CLOSE}y`)).toBe('xy');
    expect(f.flush()).toBeNull();
  });

  it('strips a think block split across two pushes', () => {
    const f = createThinkFilter();
    expect(f.push(`x${OPEN}sec`)).toBe('x');
    expect(f.push(`ret${CLOSE}y`)).toBe('y');
    expect(f.flush()).toBeNull();
  });

  it('holds text inside a think block until the close arrives', () => {
    const f = createThinkFilter();
    expect(f.push('x')).toBe('x');
    expect(f.push(`${OPEN}inside`)).toBeNull();
    expect(f.push(' more')).toBeNull();
    expect(f.push(`${CLOSE}after`)).toBe('after');
    expect(f.flush()).toBeNull();
  });

  it('strips a stray closing tag without an opener (single push)', () => {
    const f = createThinkFilter();
    // No '<' in "le IV." — it flushes immediately.
    expect(f.push('le IV.')).toBe('le IV.');
    // First push ends with a stray full close tag — strip it, return
    // the visible text before/after.
    expect(f.push(`${CLOSE}visions.`)).toBe('visions.');
    expect(f.flush()).toBeNull();
  });

  it('strips a stray closing tag split across two pushes', () => {
    const f = createThinkFilter();
    expect(f.push('le IV.')).toBe('le IV.');
    // First push ends with partial close — held until we know if
    // it's a tag.
    expect(f.push('</th')).toBeNull();
    // Second push completes the close tag — stripped, "visions." is emitted.
    expect(f.push('ink>visions.')).toBe('visions.');
    expect(f.flush()).toBeNull();
  });

  it('strips multiple stray closing tags in a row', () => {
    const f = createThinkFilter();
    expect(f.push(`a${CLOSE}b${CLOSE}c`)).toBe('abc');
    expect(f.flush()).toBeNull();
  });

  it('strips a stray closer sitting in the buffer at flush time', () => {
    const f = createThinkFilter();
    expect(f.push('hello ')).toBe('hello ');
    expect(f.push(`</th`)).toBeNull();
    // Stream ends with partial close still in buffer — flush() must
    // not leak the partial close.
    expect(f.flush()).toBeNull();
  });

  it('does not leak a complete stray closer via flush()', () => {
    const f = createThinkFilter();
    expect(f.push('hello')).toBe('hello');
    expect(f.push(` world${CLOSE}`)).toBe(' world');
    expect(f.flush()).toBeNull();
  });

  it('handles a stray closer after a legitimate think block', () => {
    const f = createThinkFilter();
    expect(f.push(`a${OPEN}secret${CLOSE}b`)).toBe('ab');
    // After the legitimate closer, we're outside the block again —
    // a second stray closer should also be stripped.
    expect(f.push(`c${CLOSE}d`)).toBe('cd');
    expect(f.flush()).toBeNull();
  });

  it('does not break on a single partial opener at the boundary', () => {
    const f = createThinkFilter();
    // Pushes a partial opener across the boundary, then completes
    // it. Should not leak the "<" itself.
    expect(f.push('a<')).toBe('a');
    expect(f.push(`${OPEN.slice(1)}b${CLOSE}c`)).toBe('c');
    expect(f.flush()).toBeNull();
  });

  it('withholds everything when an opener has no closer (signal.aborted case)', () => {
    const f = createThinkFilter();
    expect(f.push('a')).toBe('a');
    expect(f.push(`${OPEN}unfinished thought`)).toBeNull();
    // Stream cuts off inside a think block — flush() returns null,
    // matching Phase 02 behavior (the chat stream aborts and the
    // partial message is not persisted).
    expect(f.flush()).toBeNull();
  });
});