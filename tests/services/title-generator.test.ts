import { describe, it, expect, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});

vi.mock('openai', () => ({
  default: function () {
    return {
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    };
  },
}));

import {
  generateConversationTitle,
  fallbackTitle,
} from '../../src/services/title-generator.js';

describe('generateConversationTitle', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns the LLM-produced title with quotes/punctuation stripped', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '"Habit loop notes."' } }],
    });
    const out = await generateConversationTitle(
      'What did I read about habit loops?',
      'You wrote that the cue is invisible until you name it.'
    );
    expect(out).toBe('Habit loop notes');
  });

  it('clamps oversized titles to 80 chars', async () => {
    const long = 'A'.repeat(200);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: long } }],
    });
    const out = await generateConversationTitle('x', 'y');
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it('returns empty string on empty content (caller should fall back)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '' } }],
    });
    const out = await generateConversationTitle('x', 'y');
    expect(out).toBe('');
  });

  it('passes through the abort signal', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'A title' } }],
    });
    const ac = new AbortController();
    await generateConversationTitle('x', 'y', ac.signal);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 30, temperature: 0.3 }),
      expect.objectContaining({ signal: ac.signal })
    );
  });
});

describe('fallbackTitle', () => {
  it('returns short messages as-is', () => {
    expect(fallbackTitle('hello there')).toBe('hello there');
  });

  it('ellipsises at 60 chars', () => {
    const long = 'a'.repeat(120);
    const out = fallbackTitle(long);
    // 57 chars of input + the 1-char Unicode ellipsis (…)
    expect(out.length).toBe(58);
    expect(out.endsWith('…')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(fallbackTitle('  hello  ')).toBe('hello');
  });
});