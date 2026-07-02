import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import type Database from 'better-sqlite3';
import {
  embedText,
} from './embed.js';
import {
  searchChunks,
  type DocumentChunk,
} from './qdrant.js';
import {
  streamChatCompletionWithTools,
  type ChatMessage,
  type ToolCallDelta,
} from './openai-api-wrapper.js';
import {
  AGENT_TOOLS,
  executeAgentTool,
  isAgentToolName,
  type AgentToolResult,
} from './agent-tools.js';
import { countTokens, truncateToTokenBudget } from '../utils/text-token-budget.js';
import { chatLog as log } from '../utils/logger.js';

type DB = Database.Database;

// Phase 03 / p3-T07 — bounded agent loop.
//
// The loop turns `expand=auto` chat requests into up to
// MAX_AGENT_ITERATIONS rounds of (LLM call → tool execution → tool
// result → LLM call → …) before yielding a final answer. Each
// iteration's tool-result text is capped at TOOL_RESULT_TOKEN_CAP
// tokens; later calls in the same iteration may be truncated once the
// running total would exceed the cap (per OQ-8 / OD-8 — preserve order
// of execution).
//
// AbortSignal is honored between iterations, between tool calls, and
// at the top of every yield — a client disconnect returns the
// generator cleanly with no orphan LLM call.
//
// The initial retrieval (embed + search) is always done so the LLM
// has a useful starting context; the four tools let it drill in
// further if needed (OD-7 / OQ-7 resolved).

const MAX_AGENT_ITERATIONS = parseInt(process.env.MAX_AGENT_ITERATIONS || '3', 10);
const TOOL_RESULT_TOKEN_CAP = parseInt(process.env.TOOL_RESULT_TOKEN_CAP || '10000', 10);

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions based on the user's documents.

You have access to four retrieval tools:
  - get_neighbor_chunks(filePath, chunkIndex, range): see what comes before/after a passage
  - get_section_chunks(filePath, headingPath): see the full section a passage came from
  - get_chunk(chunkId): fetch a specific chunk by ID
  - get_document(filePath): see what a document contains

Use them when the initial context isn't enough to answer confidently.
When you have enough context, respond with the answer and no tool calls.

When you do call a tool, call it with the precise argument shape the tool expects; arguments are JSON-encoded by the platform so send valid JSON.`;

const NO_FINAL_ANSWER_PLACEHOLDER =
  "I wasn't able to find a definitive answer within the iteration limit.";

// Phase 03 / p3-T08 — StreamEvent union gains tool_call / tool_result
// for the agentic path. The non-agentic path (stream-chat.ts) emits
// only meta / sources / token / done / error and is unchanged.
export type AgentStreamEvent =
  | { type: 'sources'; sources: DocumentChunk[] }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown>; iteration: number }
  | {
      type: 'tool_result';
      name: string;
      result: AgentToolResult;
      truncated: boolean;
      iteration: number;
    }
  | { type: 'done'; iterations: number }
  | { type: 'error'; message: string };

export interface StreamAgentChatParams {
  question: string;
  sessionId: string;
  limit?: number;
  conversationHistory?: ChatMessage[];
  /** SQLite db the agent loop uses for `get_document` tool calls. */
  db: DB;
  /** Optional dependency overrides (tests inject mocks here). */
  deps?: Partial<AgentLoopDeps>;
}

export interface AgentLoopDeps {
  embedText: (text: string) => Promise<number[]>;
  searchChunks: (
    vector: number[],
    opts: { limit?: number }
  ) => Promise<DocumentChunk[]>;
  streamChatCompletionWithTools: (
    messages: ChatCompletionMessageParam[],
    tools: typeof AGENT_TOOLS,
    signal: AbortSignal
  ) => AsyncGenerator<{ text: string; toolCalls: ToolCallDelta[] }>;
  executeAgentTool: (
    name: string,
    args: Record<string, unknown>,
    db: DB
  ) => Promise<AgentToolResult>;
}

const defaultDeps: AgentLoopDeps = {
  embedText,
  searchChunks,
  streamChatCompletionWithTools,
  executeAgentTool,
};

function formatChunksForPrompt(chunks: DocumentChunk[]): string {
  if (chunks.length === 0) return '(no matching documents — call get_document to find them)';
  return chunks
    .map(
      (c, i) =>
        `[Source ${i + 1}] ${c.payload.fileName}${c.payload.pageNumber ? ` (p.${c.payload.pageNumber})` : ''}\n${c.payload.chunk}`
    )
    .join('\n\n');
}

function buildHistoryText(history: ChatMessage[]): string {
  return history
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Yield a stream of AgentStreamEvents for an `expand=auto` chat. The
 * initial retrieval happens before any LLM call; sources are yielded
 * once; up to MAX_AGENT_ITERATIONS rounds follow; a `done` event
 * carries the actual iteration count (1 to MAX_AGENT_ITERATIONS) so
 * the caller can render "iter N" in the UI.
 *
 * The persisted `toolCalls` are NOT returned through the generator —
 * the route handler pairs the SSE `tool_call` / `tool_result` events
 * it observes to build the persisted record (the events are the
 * contract).
 */
export async function* streamAgentChat(
  params: StreamAgentChatParams,
  signal: AbortSignal
): AsyncGenerator<AgentStreamEvent> {
  const deps: AgentLoopDeps = { ...defaultDeps, ...(params.deps ?? {}) };
  const limit = params.limit ?? 5;

  // ---- Initial retrieval (cheap; gives the LLM a useful baseline). ----
  let queryVector: number[];
  try {
    queryVector = await deps.embedText(params.question);
  } catch (err) {
    log.error({ err, sessionId: params.sessionId }, 'embedText failed for agent loop');
    yield { type: 'error', message: 'embedding unavailable' };
    return;
  }
  if (signal.aborted) return;

  const baseResults = await deps.searchChunks(queryVector, { limit });
  if (signal.aborted) return;
  yield { type: 'sources', sources: baseResults };

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Conversation History:\n${buildHistoryText(params.conversationHistory ?? []) || 'No previous conversation'}\n\n` +
        `Relevant Documents:\n${formatChunksForPrompt(baseResults)}\n\n` +
        `Current Question: ${params.question}`,
    },
  ];

  // ---- Bounded agent loop ----
  let finalText = '';
  let iterations = 0;

  for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
    if (signal.aborted) return;
    iterations = iter + 1;

    let textAccum = '';
    // Reset the accumulator each iteration — a fresh stream means a
    // fresh set of tool calls. Without this, an empty toolCalls
    // frame in iter N would carry over the tool_calls from iter
    // N-1 and the loop would never terminate.
    let finalToolCalls: ToolCallDelta[] = [];

    try {
      for await (const ev of deps.streamChatCompletionWithTools(messages, AGENT_TOOLS, signal)) {
        if (signal.aborted) return;
        if (ev.text) {
          textAccum += ev.text;
          yield { type: 'token', text: ev.text };
        }
        if (ev.toolCalls.length > 0) {
          finalToolCalls = ev.toolCalls;
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      log.error({ err, sessionId: params.sessionId, iter }, 'streamChatCompletionWithTools threw');
      yield { type: 'error', message: 'Chat failed' };
      return;
    }

    finalText = textAccum;

    // Filter to tool calls that completed during the stream. A
    // partial call (missing id or name) is dropped — the LLM didn't
    // actually finish it.
    const completeCalls = finalToolCalls.filter((c) => c.id && c.name);
    if (completeCalls.length === 0) {
      // No tools called → final answer.
      yield { type: 'done', iterations };
      return;
    }

    // Append the assistant message with its tool_calls so the next
    // LLM call sees them.
    messages.push({
      role: 'assistant',
      content: textAccum,
      tool_calls: completeCalls.map((c) => ({
        id: c.id!,
        type: 'function' as const,
        function: { name: c.name!, arguments: c.arguments },
      })),
    });

    // Emit one `tool_call` event per call BEFORE the tool executes
    // (per FR-18).
    for (const c of completeCalls) {
      yield {
        type: 'tool_call',
        name: c.name!,
        arguments: safeParseArgs(c.arguments),
        iteration: iter,
      };
    }

    // Sequential tool execution (preserves iteration order for the
    // per-iteration token cap; OQ-8 / OD-8 resolution).
    let tokenTotal = 0;
    const toolMessages: ChatCompletionMessageParam[] = [];

    for (const c of completeCalls) {
      if (signal.aborted) return;
      const toolName = c.name!;
      const parsedArgs = safeParseArgs(c.arguments);

      let result: AgentToolResult;
      if (!isAgentToolName(toolName)) {
        result = {
          kind: 'error',
          code: 'INVALID_ARG',
          message: `Unknown tool '${toolName}'`,
        };
      } else {
        try {
          result = await deps.executeAgentTool(toolName, parsedArgs, params.db);
        } catch (err) {
          log.error({ err, toolName, sessionId: params.sessionId }, 'executeAgentTool threw');
          result = {
            kind: 'error',
            code: 'NOT_FOUND',
            message: err instanceof Error ? err.message : 'tool execution failed',
          };
        }
      }

      // Apply per-iteration token cap to the JSON-serialized result.
      const resultJson = JSON.stringify(result);
      const resultTokens = countTokens(resultJson);
      let truncated = false;
      let finalJson = resultJson;
      if (tokenTotal + resultTokens > TOOL_RESULT_TOKEN_CAP) {
        const remaining = Math.max(TOOL_RESULT_TOKEN_CAP - tokenTotal, 0);
        if (remaining > 0) {
          finalJson = truncateToTokenBudget(resultJson, remaining);
        } else {
          // Already at or over the cap; the LLM still needs to see
          // the tool returned something so the conversation history
          // stays valid. A tiny marker.
          finalJson = '{"kind":"error","code":"INVALID_ARG","message":"truncated: per-iteration tool-result token cap reached"}';
        }
        truncated = true;
      }
      tokenTotal += countTokens(finalJson);

      // Emit `tool_result` event with the post-truncation payload
      // (parsed back to a JSON value for the wire — for chunks and
      // documents the SPA can render rich previews; for errors the
      // LLM sees the structured message).
      let resultForWire: unknown;
      try {
        resultForWire = JSON.parse(finalJson);
      } catch {
        resultForWire = finalJson;
      }

      yield {
        type: 'tool_result',
        name: toolName,
        result: resultForWire as AgentToolResult,
        truncated,
        iteration: iter,
      };

      // Tool messages use the PRE-truncation JSON in the LLM
      // conversation history when the cap wasn't hit (the LLM gets
      // the full result); when the cap was hit, use the truncated
      // JSON so the history matches what we emitted.
      toolMessages.push({
        role: 'tool',
        tool_call_id: c.id!,
        content: finalJson,
      });

      // Tool-retrieved chunks are surfaced via this `tool_result`
      // event (`result.chunks`). The route handler
      // (routes/chat-stream.ts) aggregates them into the persisted
      // `sources` field on the assistant message (FR-19, FR-6).
      // We intentionally do NOT mutate `baseResults` here — that
      // would shift the array captured by the initial `sources`
      // event under the route handler.
    }

    // Append tool messages so the next LLM call sees the tool
    // responses in context.
    for (const m of toolMessages) messages.push(m);
  }

  // Hit MAX_AGENT_ITERATIONS without a final answer — emit done with
  // whatever text was accumulated (or a placeholder if empty).
  if (!finalText.trim()) {
    yield { type: 'token', text: NO_FINAL_ANSWER_PLACEHOLDER };
  }
  yield { type: 'done', iterations: MAX_AGENT_ITERATIONS };
}