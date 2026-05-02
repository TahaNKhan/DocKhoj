import Anthropic from '@anthropic-ai/sdk';
import { llmLog as log } from '../utils/logger.js';

// // creating a client instance for Anthropic API (through their official SDK)
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// use LLM_MODEL from environment variables, otherwise dfault to "claude-3-5-sonnet-latest"
const LLM_MODEL = process.env.LLM_MODEL || 'claude-3-5-sonnet-latest';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// core function that actually calls the API
async function chatCompletion(
  messages: { role: 'user' | 'assistant'; content: string }[],
  systemPrompt?: string
): Promise<string> {
  const response = await anthropic.messages.create({
    model: LLM_MODEL,
    max_tokens: 1000,
    temperature: 0.3,
    system: systemPrompt ?? '',
    messages,
  });

  const text = response.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');

  return stripThinkTags(text);
}

export async function createChatCompletion(
  messages: { role: 'user' | 'assistant'; content: string }[]
): Promise<string> {
  try {
    log.debug({ model: LLM_MODEL, messageCount: messages.length }, 'Anthropic chat completion');
    return await chatCompletion(messages);
  } catch (err) {
    log.error({ err }, 'Anthropic API error');
    throw new Error('Failed to generate chat completion');
  }
}