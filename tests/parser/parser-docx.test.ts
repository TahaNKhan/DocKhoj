import { describe, it, expect, vi } from 'vitest';

const { mockExtractRawText } = vi.hoisted(() => ({
  mockExtractRawText: vi.fn(),
}));

vi.mock('mammoth', () => ({
  default: {
    extractRawText: mockExtractRawText,
  },
}));

import { parseDocx } from '../../src/parser/parser-docx.js';

// T43 — coverage for the docx parser. We mock mammoth.extractRawText
// so the test doesn't need a real .docx file. Real .docx behavior is
// validated by the e2e tests in T18.

describe('parseDocx', () => {
  it('returns an empty block list for empty input', async () => {
    mockExtractRawText.mockResolvedValueOnce({ value: '', messages: [] });
    const out = await parseDocx('/tmp/empty.docx');
    expect(out).toEqual([]);
  });

  it('produces paragraph blocks for plain text', async () => {
    mockExtractRawText.mockResolvedValueOnce({
      value: 'first paragraph\n\nsecond paragraph',
      messages: [],
    });
    const out = await parseDocx('/tmp/whatever.docx');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'paragraph', text: 'first paragraph' });
    expect(out[1]).toMatchObject({ kind: 'paragraph', text: 'second paragraph' });
  });

  it('extracts heading depth from styleName in mammoth messages', async () => {
    mockExtractRawText.mockResolvedValueOnce({
      value: 'Title\n\nBody text',
      messages: [
        { type: 'paragraphStyle', message: 'Title', styleName: 'heading 1' },
      ],
    });
    const out = await parseDocx('/tmp/two.docx');
    const heading = out.find((b) => b.kind === 'heading');
    expect(heading).toBeDefined();
    expect(heading!.depth).toBe(1);
  });

  it('handles missing messages array gracefully', async () => {
    // mammoth can return without messages
    mockExtractRawText.mockResolvedValueOnce({ value: 'just text' });
    const out = await parseDocx('/tmp/x.docx');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('paragraph');
  });
});