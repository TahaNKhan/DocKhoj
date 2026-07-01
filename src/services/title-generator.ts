import OpenAI from 'openai';
import { llmLog as log } from '../utils/logger.js';

// LLM-driven async conversation title generator (FR-14, FR-15, FR-15a).
//
// generateConversationTitle() fires off a small completion (max 30 tokens,
// low temperature) and returns a 5-8 word title for the first exchange
// of a session. Callers must NOT block the chat response on this —
// /api/chat/stream emits the title as a best-effort `event: title`
// AFTER `event: done` (per FR-15a). /api/chat awaits it concurrently
// in the response (per FR-15).
//
// On OpenAI failure, callers fall back to fallbackTitle() (60-char
// prefix of the user's first message). setGeneratedTitle in
// ConversationStore refuses to overwrite user-renamed sessions
// (title_source = 'user' or 'generated').

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o';

const TITLE_SYSTEM_PROMPT =
  'You generate concise 5-8 word conversation titles. ' +
  'Respond with ONLY the title. No quotes, no preamble, no trailing punctuation.';

interface TitleMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export async function generateConversationTitle(
  firstUserMessage: string,
  firstAssistantMessage: string,
  signal?: AbortSignal
): Promise<string> {
  const messages: TitleMessage[] = [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `User asked: ${firstUserMessage.slice(0, 500)}\n\n` +
        `Assistant answered: ${firstAssistantMessage.slice(0, 1000)}`,
    },
  ];
  const response = await openai.chat.completions.create(
    {
      model: LLM_MODEL,
      messages,
      max_tokens: 30,
      temperature: 0.3,
    },
    signal ? { signal } : undefined
  );
  const raw = response.choices?.[0]?.message?.content?.trim() ?? '';
  // Strip any chain-of-thought the model emitted before the title,
  // then dedupe lines (models sometimes wrap the title in
  // quotes on a separate line).
  const noThink = raw.replace(/<\/?think>/g, '').trim();
  const cleaned = noThink
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?]+$/, '')
    .slice(0, 80)
    .trim();
  if (!cleaned) {
    log.warn({ raw }, 'Title generator returned empty; caller should fall back');
  }
  return cleaned;
}

/**
 * Fallback title used when the LLM call fails or returns empty.
 * First 60 chars of the user's first message, ellipsised.
 */
export function fallbackTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57).trimEnd() + '…';
}