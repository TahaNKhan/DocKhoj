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
      expect.objectContaining({ max_tokens: 20, temperature: 0.3 }),
      expect.objectContaining({ signal: ac.signal })
    );
  });

  it('strips a leading "Title:" prefix the model occasionally emits', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Title: Cooking pasta al dente' } }],
    });
    expect(await generateConversationTitle('x', 'y')).toBe('Cooking pasta al dente');
  });

  it('falls back to the topic phrase inside the think block when the LLM emits nothing visible', async () => {
    // Pattern observed with MiniMax-M3: the model wraps everything
    // in `<think>...</think>` and emits no text after — so the
    // extractor has to mine the block.
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content:
            '<think>The user asked about cooking pasta, but the assistant response was about HOA documents. The topic is cooking pasta.</think>',
        },
      }],
    });
    const out = await generateConversationTitle('x', 'y');
    // Extractor pulls "cooking pasta" — whatever sits after "about".
    expect(out.toLowerCase()).toContain('cooking pasta');
  });

  it('strips an entire <think>...</think> block when content follows', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content:
            '<think>Some reasoning that should not leak through.</think>Pasta cooking tips',
        },
      }],
    });
    const out = await generateConversationTitle('x', 'y');
    expect(out).toBe('Pasta cooking tips');
  });

  it('returns empty string when the think block has no extractable topic', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: '<think>The user asked a question.</think>',
        },
      }],
    });
    expect(await generateConversationTitle('x', 'y')).toBe('');
  });

  it('discards titles that look like leaked system-prompt fragments', async () => {
    // MiniMax-M3 regurgitation patterns observed in production.
    for (const leaked of [
      '(5-8 words, ≤80 chars',
      '5-8 words or less',
      'respond with only the title',
      'do not wrap your response',
      'Output: title here',
      'the user asked about cooking',
    ]) {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: leaked } }],
      });
      const out = await generateConversationTitle('x', 'y');
      expect(out, `should have discarded "${leaked}"`).toBe('');
    }
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