import { embedText } from '../services/embed.js';
import { searchChunks, expandHits, type ExpandMode, type DocumentChunk } from '../services/qdrant.js';
import { streamChatCompletionRaw, type ChatMessage } from '../services/openai-api-wrapper.js';
import { chatLog as log } from '../utils/logger.js';

// Stream orchestrator: the embed → search → prompt → LLM-stream
// pipeline that backs /api/chat/stream. Yields typed `StreamEvent`
// frames which the SSE route handler forwards to the client.
//
// Disconnect handling: the caller passes an AbortSignal. When it
// fires, this generator stops yielding (the underlying
// openai.chat.completions stream is also aborted, so the in-flight
// network request is cancelled — per FR-21).

export type StreamEvent =
  | { type: 'meta'; sessionId: string; userMessageId: string }
  | { type: 'sources'; sources: DocumentChunk[] }
  | { type: 'token'; text: string }
  | { type: 'done'; messageId?: string; totalTokens?: number }
  | { type: 'error'; message: string };

interface Params {
  question: string;
  sessionId: string;
  contextChunks?: never;
  conversationHistory?: ChatMessage[];
  limit?: number;
  expandMode?: ExpandMode;
}

function buildHistoryText(history: ChatMessage[]): string {
  return history
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
}

export async function* streamChatCompletion(
  params: Params,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  // Source chips carried through to the client. We re-use these
  // DocumentChunk objects so the SPA can render [Source N] fileName
  // pageNumber headingPath score immediately.
  const queryVector = await embedText(params.question);
  const baseResults = await searchChunks(queryVector, { limit: params.limit ?? 5 });
  const results = await expandHits(baseResults, { mode: params.expandMode ?? 'none' });

  yield { type: 'sources', sources: results };

  const contextText = results
    .map((c, i) => `[Source ${i + 1}] ${c.payload.fileName}:\n${c.payload.chunk}`)
    .join('\n\n');
  const historyText = buildHistoryText(params.conversationHistory ?? []);

  const systemPrompt = `You are a helpful assistant that answers questions based on the provided documents.
Use the context to provide accurate answers. Keep track of the conversation history.
If the answer cannot be found in the context, say so.`;

  const userPrompt = `Conversation History:
${historyText || 'No previous conversation'}

Relevant Documents:
${contextText || '(no matching documents — answer the question from general knowledge but mention you have no source)'}

Current Question: ${params.question}`;

  let emittedAny = false;
  try {
    for await (const ev of streamChatCompletionRaw(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      signal
    )) {
      if (ev.text) {
        emittedAny = true;
        yield { type: 'token', text: ev.text };
      }
    }
    if (!emittedAny) {
      log.warn({ sessionId: params.sessionId }, 'Stream completed with zero tokens');
    }
    yield { type: 'done' };
  } catch (err) {
    if (signal.aborted) {
      log.info({ sessionId: params.sessionId }, 'Stream aborted by client disconnect');
      return;
    }
    const message = err instanceof Error ? err.message : 'Chat stream failed';
    log.error({ err, sessionId: params.sessionId }, 'Stream error');
    yield { type: 'error', message };
  }
}