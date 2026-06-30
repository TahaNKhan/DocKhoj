import { describe, it, expect, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
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

import { createChatCompletion, chatWithDocuments } from '../../src/services/openai-api-wrapper.js';

describe('createChatCompletion', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns the message content from the first choice', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'the answer' } }],
    });
    const out = await createChatCompletion([
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toBe('the answer');
  });

  it('strips  think tags from the response', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        { message: { content: 'the actual answer' } },
      ],
    });
    const out = await createChatCompletion([
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toContain('the actual answer');
  });

  it('throws an error when the API call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('upstream down'));
    await expect(
      createChatCompletion([{ role: 'user', content: 'hi' }])
    ).rejects.toThrow(/Failed to generate/);
  });
});

describe('chatWithDocuments', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns an answer with source previews', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'the answer based on docs' } }],
    });
    const response = await chatWithDocuments('What is X?', [
      {
        fileName: 'notes.md',
        filePath: 'abc.md',
        chunk: 'Some content about X. '.repeat(50),
        score: 0.9,
      },
    ]);

    expect(response.answer).toBe('the answer based on docs');
    expect(response.sources).toHaveLength(1);
    expect(response.sources[0].fileName).toBe('notes.md');
    expect(response.sources[0].text.endsWith('...') || response.sources[0].text.length <= 200).toBe(true);
  });
});