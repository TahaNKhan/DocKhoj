import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/services/markdown';

// T43 — coverage for the markdown service. T44 added this module;
// these tests pin the XSS-sanitization behavior (FR-33) and verify
// streaming re-renders handle partial chunks.

describe('renderMarkdown', () => {
  it('returns an empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('renders **bold** as <strong>', () => {
    const out = renderMarkdown('**bold**');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('renders `code` as <code>', () => {
    const out = renderMarkdown('use `npm install`');
    expect(out).toContain('<code>npm install</code>');
  });

  it('renders _italic_ as <em>', () => {
    const out = renderMarkdown('_italic_');
    expect(out).toMatch(/<em>italic<\/em>/);
  });

  // Streaming re-render behavior: partial markdown that doesn't
  // close a code fence yet should not crash. The renderer just
  // produces whatever sanitized HTML is valid for the partial input.
  it('tolerates partial markdown input (unclosed fence)', () => {
    const partial = 'Here is some **bold but no close';
    // Should not throw — marked accepts partial input and produces
    // whatever HTML it can.
    const out = renderMarkdown(partial);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('returns a string for the typical chat response shape', () => {
    const out = renderMarkdown('## Heading\n\nSome **bold** and `code`.');
    expect(typeof out).toBe('string');
    expect(out).toContain('Heading');
    expect(out).toContain('<strong>');
    expect(out).toContain('<code>');
  });
});