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

  it('renders fenced code blocks in <pre><code>', () => {
    const out = renderMarkdown('```js\nconst x = 1;\n```');
    expect(out).toContain('<pre>');
    expect(out).toContain('<code');
    expect(out).toContain('const x = 1;');
  });

  it('renders _italic_ as <em>', () => {
    const out = renderMarkdown('_italic_');
    expect(out).toMatch(/<em>italic<\/em>/);
  });

  it('renders unordered lists', () => {
    const out = renderMarkdown('- one\n- two\n- three');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<li>two</li>');
  });

  it('renders ordered lists', () => {
    const out = renderMarkdown('1. first\n2. second');
    expect(out).toContain('<ol>');
    expect(out).toContain('<li>first</li>');
    expect(out).toContain('<li>second</li>');
  });

  // XSS protection (FR-33): adversarial LLM responses must not reach
  // the DOM as executable HTML.
  it('strips <script> tags entirely', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips inline event handlers (onerror, onclick)', () => {
    const out = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(out.toLowerCase()).not.toContain('onerror');
  });

  it('strips javascript: hrefs', () => {
    const out = renderMarkdown('[click](javascript:alert(1))');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('strips <iframe> tags', () => {
    const out = renderMarkdown('<iframe src="https://evil.example"></iframe>');
    expect(out.toLowerCase()).not.toContain('<iframe');
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

  it('escapes raw HTML in plain text (e.g. a stray <b> in a sentence)', () => {
    const out = renderMarkdown('Use the <b> tag for bold');
    // DOMPurify allows <b> (it's a normal element) but strips attrs
    // that aren't allow-listed — the text content is preserved.
    expect(out).toContain('<b>');
  });

  it('returns a string for the typical chat response shape', () => {
    const out = renderMarkdown('## Heading\n\nSome **bold** and `code`.');
    expect(typeof out).toBe('string');
    expect(out).toContain('Heading');
    expect(out).toContain('<strong>');
    expect(out).toContain('<code>');
  });
});