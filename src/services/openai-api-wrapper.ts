import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { llmLog as log } from '../utils/logger.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o';

// Context size — resolved at module load in this order:
//   1. `LLM_CONTEXT_SIZE` env var (explicit operator override; wins
//      outright — useful when the chat provider doesn't expose the
//      field via /v1/models and the model isn't in our table).
//   2. Probe `/v1/models/{LLM_MODEL}` and read whichever extension
//      field the provider actually exposes:
//        - Ollama / Ollama Cloud:   context_length
//        - LM Studio:               max_context_length
//        - vLLM / TGI:              max_model_len
//        - OpenAI / Azure / Anthropic via gateway: nothing
//   3. Built-in size table for ~25 popular models.
//
// Returns `null` when none of the above knows the size — the SPA
// renders the model name without a ctx pill and the operator can set
// `LLM_CONTEXT_SIZE` to fix it.

let cachedContextSize: number | null | undefined = undefined;

const LLM_CONTEXT_SIZE_OVERRIDE = (() => {
  const raw = process.env.LLM_CONTEXT_SIZE;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const KNOWN_CONTEXT_SIZES: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,
  // Anthropic (when routed through an OpenAI-compatible gateway)
  'claude-3-5-sonnet-latest': 200_000,
  'claude-3-5-haiku-latest': 200_000,
  'claude-3-opus-latest': 200_000,
  // Common local Ollama defaults
  'llama3.1': 128_000,
  'llama3.1:8b': 128_000,
  'llama3.1:70b': 128_000,
  'llama-3.1': 128_000,
  'llama3.2': 128_000,
  'qwen2.5': 32_768,
  'mistral': 32_768,
};

function lookupKnownContextSize(modelId: string): number | null {
  if (KNOWN_CONTEXT_SIZES[modelId] !== undefined) return KNOWN_CONTEXT_SIZES[modelId];
  // Try prefix matches for variant strings like "llama3.1:8b-instruct-q4_K_M".
  for (const [key, size] of Object.entries(KNOWN_CONTEXT_SIZES)) {
    if (modelId.startsWith(key)) return size;
  }
  return null;
}

async function probeContextSize(): Promise<number | null> {
  try {
    const info = await openai.models.retrieve(LLM_MODEL);
    // Cast to a record so we can probe extension fields without the
    // SDK TypeScript types complaining.
    const raw = info as unknown as Record<string, unknown>;
    const candidates: unknown[] = [
      raw['context_length'],
      raw['max_context_length'],
      raw['max_model_len'],
      raw['context_window'],
      raw['max_input_tokens'],
    ];
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
    }
  } catch (err) {
    log.warn({ err, model: LLM_MODEL }, 'Context-size probe failed; using known-table fallback');
  }
  return lookupKnownContextSize(LLM_MODEL);
}

async function ensureContextSize(): Promise<number | null> {
  if (cachedContextSize !== undefined) {
    return cachedContextSize;
  }
  if (LLM_CONTEXT_SIZE_OVERRIDE !== null) {
    cachedContextSize = LLM_CONTEXT_SIZE_OVERRIDE;
    log.info(
      { model: LLM_MODEL, contextSize: cachedContextSize, source: 'LLM_CONTEXT_SIZE env override' },
      'LLM context size set via env override'
    );
    return cachedContextSize;
  }
  const probed = await probeContextSize();
  cachedContextSize = probed;
  if (cachedContextSize !== null) {
    log.info({ model: LLM_MODEL, contextSize: cachedContextSize }, 'LLM context size resolved');
  } else {
    log.info({ model: LLM_MODEL }, 'LLM context size unknown; set LLM_CONTEXT_SIZE to override');
  }
  return cachedContextSize;
}

/** Returns the LLM's context size in tokens (probed at boot, or the
 *  value of `LLM_CONTEXT_SIZE` if set). `null` when the size is
 *  unknown — the SPA will render the model name without a ctx pill
 *  and the operator can set the env var to fix it. */
export async function getLlmContextSize(): Promise<number | null> {
  return ensureContextSize();
}

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

/**
 * Streaming chat completion. Yields `{ text }` chunks from
 * openai.chat.completions.create({ stream: true }, { signal }). The
 * caller is responsible for forwarding each chunk to the SSE
 * response and assembling the full answer.
 *
 * Abort signal is passed through so a client disconnect can
 * cancel the in-flight request (FR-21).
 */
export async function* streamChatCompletionRaw(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  signal: AbortSignal
): AsyncGenerator<{ text: string }> {
  const stream = await openai.chat.completions.create(
    {
      model: LLM_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 1000,
      stream: true,
    },
    { signal }
  );
  for await (const chunk of stream) {
    const text = chunk.choices?.[0]?.delta?.content ?? '';
    if (text) yield { text };
  }
}

// Phase 03 / p3-T06 — streaming chat completion with the LLM's tool-use
// loop enabled (FR-14, FR-18).
//
// The OpenAI SDK streams `delta.content` as text deltas (same as
// streamChatCompletionRaw) AND `delta.tool_calls[]` as partial tool
// calls per chunk. Each partial has an `index` (final position in the
// tool_calls array) and incremental `id` / `function.name` /
// `function.arguments` fields. We accumulate across chunks and emit
// a snapshot per chunk so the caller can stream-progress tool calls if
// it wants; the final accumulator after stream-end is the source of
// truth the agent loop acts on.
//
// Yielded shape:
//   { text: string; toolCalls: ToolCallDelta[] }
//
// `text` is the new text delta only (empty string when the chunk had
// no content). `toolCalls` is the accumulated array — empty when the
// chunk had no tool_calls; otherwise the full set of completed-final
// or in-progress call records at that point. The caller should treat
// the *last* `toolCalls` snapshot after stream-end as the finalized
// list (intermediate snapshots may be partially-formed mid-function).
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

export async function* streamChatCompletionWithTools(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  signal: AbortSignal
): AsyncGenerator<{ text: string; toolCalls: ToolCallDelta[] }> {
  log.debug(
    { model: LLM_MODEL, messageCount: messages.length, toolCount: tools.length },
    'Starting streaming completion with tools'
  );

  const stream = await openai.chat.completions.create(
    {
      model: LLM_MODEL,
      messages,
      tools,
      temperature: 0.3,
      max_tokens: 1000,
      stream: true,
    },
    { signal }
  );

  // ToolCall accumulator indexed by the SDK's `index` field. Each
  // position in the final tool_calls array receives incremental
  // pieces (id, name, arguments) across one-or-more chunks. We hold
  // them here so the caller can see a stable snapshot each yield.
  const calls: ToolCallDelta[] = [];

  for await (const chunk of stream) {
    if (signal.aborted) {
      log.info('streamChatCompletionWithTools: abort observed mid-stream');
      return;
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    const text = (delta?.content ?? '') as string;
    const partials = delta?.tool_calls;

    if (partials && partials.length > 0) {
      for (const p of partials) {
        const idx = typeof p.index === 'number' ? p.index : 0;
        if (!calls[idx]) {
          calls[idx] = { index: idx, arguments: '' };
        }
        const slot = calls[idx]!;
        if (p.id) slot.id = p.id;
        if (p.function?.name) slot.name = p.function.name;
        if (typeof p.function?.arguments === 'string') {
          slot.arguments += p.function.arguments;
        }
      }
    }

    // Snapshot — text delta plus the full accumulator so far.
    yield { text, toolCalls: calls.map((c) => ({ ...c, arguments: c.arguments })) };
  }

  // After stream-end we deliberately do NOT yield an extra frame; the
  // last yield in the loop above already carries the full
  // accumulator. If the SDK never emitted tool_calls for this stream,
  // `calls` stays empty and the caller sees `toolCalls: []`.
}