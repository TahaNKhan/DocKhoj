import OpenAI from 'openai';
import { llmLog as log } from '../utils/logger.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DocumentChunk {
  fileName: string;
  filePath: string;
  chunk: string;
  score: number;
}

export interface Source {
  fileName: string;
  filePath: string;
  text: string;
  score: number;
}

export interface ChatResponse {
  answer: string;
  sources: Source[];
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function buildContextText(chunks: DocumentChunk[]): string {
  return chunks
    .map((c, i) => `[Source ${i + 1}] ${c.fileName}:\n${c.chunk}`)
    .join('\n\n');
}

function buildHistoryText(history: ChatMessage[]): string {
  return history
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
}

async function chatCompletion(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string> {
  const response = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 1000,
  });
  return stripThinkTags(response.choices[0]?.message?.content || '');
}

export async function createChatCompletion(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
): Promise<string> {
  try {
    log.debug({ model: LLM_MODEL, messageCount: messages.length }, 'Creating chat completion');
    return await chatCompletion(messages);
  } catch (error) {
    log.error({ error }, 'LLM API error');
    throw new Error('Failed to generate chat completion');
  }
}

export async function chatWithDocuments(
  question: string,
  contextChunks: DocumentChunk[],
  conversationHistory: ChatMessage[] = []
): Promise<ChatResponse> {
  log.debug({ questionLength: question.length, contextCount: contextChunks.length }, 'Chat with documents');

  const systemPrompt = `You are a helpful assistant that answers questions based on the provided documents.
Use the context to provide accurate answers. Keep track of the conversation history.
If the answer cannot be found in the context, say so.`;

  const userPrompt = `Conversation History:
${buildHistoryText(conversationHistory) || 'No previous conversation'}

Relevant Documents:
${buildContextText(contextChunks)}

Current Question: ${question}`;

  const answer = await createChatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);

  return {
    answer,
    sources: contextChunks.map((c) => ({
      fileName: c.fileName,
      text: c.chunk.slice(0, 200) + (c.chunk.length > 200 ? '...' : ''),
      filePath: c.filePath,
      score: c.score,
    })),
  };
}