import { createChatCompletion as openaiChat } from './openai-api-wrapper.js';
import { createChatCompletion as anthropicChat } from './anthropic-api-wrapper.js';

export type LLMProviderType = 'openai' | 'anthropic';

const PROVIDER: LLMProviderType =
  (process.env.LLM_PROVIDER as LLMProviderType) || 'openai';

export async function createChatCompletion(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
): Promise<string> {
  switch (PROVIDER) {
    case 'anthropic':
      return anthropicChat(messages);

    case 'openai':
    default:
      return openaiChat(messages);
  }
}