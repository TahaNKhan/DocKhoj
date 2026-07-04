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
  regenerateConversationTitle,
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

describe('regenerateConversationTitle', () => {
  beforeEach(() => mockCreate.mockReset());

  const msgs = [
    { role: 'user', content: 'What did I read about habit loops?' },
    { role: 'assistant', content: 'You wrote that the cue is invisible until you name it.' },
    { role: 'user', content: 'How do I track my daily habits?' },
    { role: 'assistant', content: 'Try a simple journal or a habit tracker app.' },
  ];

  it('returns null when the LLM says NO_CHANGE', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'NO_CHANGE' } }],
    });
    const out = await regenerateConversationTitle(msgs, 'Habit loop notes');
    expect(out).toBeNull();
  });

  it('returns null when the LLM says no change with a sentence', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'No change needed — the current title still fits.' } }],
    });
    const out = await regenerateConversationTitle(msgs, 'Habit loop notes');
    expect(out).toBeNull();
  });

  it('returns a new title when the conversation topic shifts', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Daily habit tracking tips' } }],
    });
    const out = await regenerateConversationTitle(msgs, 'Habit loop notes');
    expect(out).toBe('Daily habit tracking tips');
  });

  it('returns null when the new title equals current title', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Habit loop notes' } }],
    });
    const out = await regenerateConversationTitle(msgs, 'Habit Loop Notes');
    expect(out).toBeNull();
  });

  it('returns null when the LLM call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API error'));
    const out = await regenerateConversationTitle(msgs, 'Habit loop notes');
    expect(out).toBeNull();
  });

  it('strips a leading "New title:" prefix', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'New title: Habit tracking with apps' } }],
    });
    const out = await regenerateConversationTitle(msgs, 'Habit loop notes');
    expect(out).toBe('Habit tracking with apps');
  });

  it('passes through the abort signal', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'NO_CHANGE' } }],
    });
    const ac = new AbortController();
    await regenerateConversationTitle(msgs, 'Current', ac.signal);
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