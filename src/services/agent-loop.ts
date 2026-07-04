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

const MAX_AGENT_ITERATIONS = parseInt(process.env.MAX_AGENT_ITERATIONS || '10', 10);
const TOOL_RESULT_TOKEN_CAP = parseInt(process.env.TOOL_RESULT_TOKEN_CAP || '10000', 10);

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions based on the user's documents.

You have access to four retrieval tools:
  - get_neighbor_chunks(filePath, chunkIndex, range): see what comes before/after a passage
  - get_section_chunks(filePath, headingPath): see the full section a passage came from
  - get_chunk(chunkId): fetch a specific chunk by ID
  - get_document(filePath): see what a document contains (accepts EITHER the on-disk basename OR the user-facing fileName)

Tool argument conventions — these are the most common mistakes:
  - filePath is the on-disk basename (e.g. "doc-uuid-aaa.pdf"). The source list shows it as file="…". Copy that value verbatim — do NOT pass the user-facing fileName.
  - chunkId is a UUID. The source list shows it as id="…". Copy that value verbatim — do NOT pass "Source 1" or the source number.
  - headingPath is an array of strings, in document order, e.g. ["Chapter 2", "Setup"]. Empty array is not a valid headingPath.

Iteration budget: you have up to ${MAX_AGENT_ITERATIONS} iterations to answer this question. Each iteration is one LLM call (potentially with multiple tool calls in the same iteration). When you have enough context to answer confidently, respond with the final answer and no further tool calls — don't keep exploring past what's needed. After each iteration you'll get a [System reminder] message telling you which iteration just finished and how many you have left; treat the last iteration as a hard deadline (respond with whatever you have, even if it's a partial answer).

Use the tools when the initial context isn't enough to answer confidently. When you have enough context, respond with the answer and no tool calls. Do not emit chain-of-thought or <think>…</think> blocks in your visible output — think internally but write only the final answer.

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
  | { type: 'tools_not_supported' }
  | { type: 'error'; message: string };

/**
 * Heuristic: when the OpenAI SDK rejects a `tools` parameter (some
 * gateways don't support it), the error message typically contains
 * the substring "tools" along with words like "not support",
 * "unsupported", "unknown parameter", etc. We use a relaxed match —
 * any error whose message contains both "tools" and a
 * support-denying word — to surface a typed `tools_not_supported`
 * event so the route handler can fall back per FR-22.
 *
 * Exported so the test suite can pin the heuristic and the route
 * handler can re-validate if it wants to.
 */
export function isToolsNotSupportedError(err: unknown): boolean {
  let message: string;
  if (err instanceof Error) {
    message = err.message;
  } else if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    message = (err as { message: string }).message;
  } else {
    message = String(err);
  }
  const lower = message.toLowerCase();
  const mentionsTools = lower.includes('tool') || lower.includes('function calling');
  const deniesSupport =
    lower.includes('not support') ||
    lower.includes('unsupported') ||
    lower.includes('unknown param') ||
    lower.includes('unknown field') ||
    lower.includes('invalid request');
  return mentionsTools && deniesSupport;
}

export interface StreamAgentChatParams {
  question: string;
  sessionId: string;
  limit?: number;
  conversationHistory?: ChatMessage[];
  /** SQLite db the agent loop uses for `get_document` tool calls. */
  db: DB;
  /** Optional dependency overrides (tests inject mocks here). */
  deps?: Partial<AgentLoopDeps>;
  // Phase 04 / p4-T11 / FR-38 — requester's id; threaded into the
  // initial searchChunks call. The agent tools (p4-T12) will thread
  // it into their own fetches too.
  viewerId?: string;
}

export interface AgentLoopDeps {
  embedText: (text: string) => Promise<number[]>;
  searchChunks: (
    vector: number[],
    opts: { limit?: number },
    // Phase 04 / p4-T11 — viewerId is the optional third arg
    // matching qdrant.searchChunks's signature. Tests that supply
    // their own mock (`async () => ...`) are unaffected since
    // extra args are ignored.
    viewerId?: string
  ) => Promise<DocumentChunk[]>;
  streamChatCompletionWithTools: (
    messages: ChatCompletionMessageParam[],
    tools: typeof AGENT_TOOLS,
    signal: AbortSignal
  ) => AsyncGenerator<{ text: string; toolCalls: ToolCallDelta[] }>;
  executeAgentTool: (
    // Phase 04 / p4-T12 / FR-39 — viewerId is threaded into every
    // tool's Qdrant fetch and into the documents-row lookup in
    // get_document. The AgentLoopDeps type widens name to `string`
    // for the DI surface; the underlying function narrows it back
    // via isAgentToolName.
    name: string,
    args: Record<string, unknown>,
    viewerId: string,
    db: DB
  ) => Promise<AgentToolResult>;
}

const defaultDeps: AgentLoopDeps = {
  embedText,
  searchChunks,
  streamChatCompletionWithTools,
  // The AgentLoopDeps type widens executeAgentTool's name parameter
  // to `string` for the dependency-injection surface; the underlying
  // function narrows it back to AgentToolName via an internal
  // isAgentToolName check. The `as typeof executeAgentTool` cast
  // bridges the two.
  executeAgentTool: executeAgentTool as AgentLoopDeps['executeAgentTool'],
};

function formatChunksForPrompt(chunks: DocumentChunk[]): string {
  if (chunks.length === 0) return '(no matching documents — call get_document to find them)';
  return chunks
    .map(
      (c, i) =>
        // p3-T13: include `file="<on-disk filePath>"` and
        // `id="<chunkId>"` so the LLM can paste them verbatim into
        // tool args. Without these the LLM guesses at `filePath`
        // (passing the user-facing fileName) and at `chunkId`
        // (passing the source label "Source N"), both of which fail.
        `[Source ${i + 1}] file="${c.payload.filePath}" id="${c.id}" ${c.payload.fileName}${c.payload.pageNumber ? ` (p.${c.payload.pageNumber})` : ''}\n${c.payload.chunk}`
    )
    .join('\n\n');
}

// Exported for unit testing — the format is part of the LLM-facing
// contract (p3-T13) so the test pins it.
export const __test__ = { formatChunksForPrompt };

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

  const baseResults = await deps.searchChunks(queryVector, { limit }, params.viewerId);
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
      // Some LLM gateways reject the `tools` parameter outright
      // (FR-22 / U11 / OD-4). Surface a typed event so the route
      // handler can fall back to the non-agentic path with a
      // single `warn` log.
      if (isToolsNotSupportedError(err)) {
        log.warn(
          { sessionId: params.sessionId, err },
          'LLM does not support tools; signalling route to fall back'
        );
        yield { type: 'tools_not_supported' };
        return;
      }
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
          // Phase 04 / p4-T12 / FR-39 — viewerId is threaded into
          // every tool so Qdrant queries honor the visibility filter
          // and get_document refuses foreign private files.
          result = await deps.executeAgentTool(
            toolName,
            parsedArgs,
            params.viewerId ?? '',
            params.db
          );
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

    // Tell the LLM where it is in the budget (p3-T17). After each
    // iteration we append a [System reminder] user message naming
    // the iteration count and remaining iterations. The hint
    // escalates as we approach the cap so a model that's already
    // answered confidently doesn't keep exploring, but a model
    // that's mid-research doesn't get pressured into a premature
    // wrap-up. Only emitted when there's still a next iteration —
    // on the final iteration the loop exits and there's no point
    // reminding.
    const remaining = MAX_AGENT_ITERATIONS - (iter + 1);
    if (remaining > 0) {
      let hint = '';
      if (remaining === 1) {
        hint = ' This is your LAST iteration — produce the final answer now (with or without further tool calls).';
      } else if (remaining <= 2) {
        hint = ' Aim to wrap up to avoid running out of iterations.';
      } else if (remaining <= Math.max(3, Math.floor(MAX_AGENT_ITERATIONS / 2))) {
        hint = ' Consider wrapping up if you can answer confidently.';
      }
      messages.push({
        role: 'user',
        content: `[System reminder] Iteration ${iter + 1} of ${MAX_AGENT_ITERATIONS} complete. ${remaining} iteration(s) remaining.${hint} If you have enough context, answer now without further tool calls.`,
      });
    }
  }

  // Hit MAX_AGENT_ITERATIONS without a final answer — emit done with
  // whatever text was accumulated (or a placeholder if empty).
  if (!finalText.trim()) {
    yield { type: 'token', text: NO_FINAL_ANSWER_PLACEHOLDER };
  }
  yield { type: 'done', iterations: MAX_AGENT_ITERATIONS };
}