import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { ConversationStore, type ToolCallRecord } from '../services/conversations.js';
import { streamChatCompletion, type StreamEvent } from '../services/stream-chat.js';
import { streamAgentChat } from '../services/agent-loop.js';
import {
  generateConversationTitle,
  fallbackTitle,
} from '../services/title-generator.js';
import { chatLog as log } from '../utils/logger.js';
import { createThinkFilter } from '../utils/think-filter.js';
import type Database from 'better-sqlite3';

type DB = Database.Database;

// POST /api/chat/stream — Server-Sent Events chat endpoint (p2-T12, p3-T08).
//
// Wire format (one SSE frame per event):
//   event: meta         data: { sessionId, userMessageId }
//   event: sources      data: DocumentChunk[]
//   event: token        data: { text }
//   event: tool_call    data: { name, arguments, iteration }     (agentic path only)
//   event: tool_result  data: { name, result, truncated, iteration }  (agentic path only)
//   event: done         data: { messageId, iterations }
//   event: title        data: { sessionId, title }                (best-effort, post-done)
//   event: error        data: { message }
//
// The dispatch table:
//   expand=none|siblings|sections → streamChatCompletion (non-agentic; Phase 02 path)
//   expand=auto                   → streamAgentChat (agentic; Phase 03 path)
//
// When expand=auto and the LLM provider doesn't support `tools`, the
// agent loop yields a `tools_not_supported` event. We fall back to
// streamChatCompletion(expand=none) so the client still gets an
// answer; the persisted `tool_calls` column is NULL (per FR-22 /
// U11 / OD-4).
//
// Disconnect handling: reply.raw.on('close') fires the
// AbortController; the in-flight stream is cancelled; the partial
// assistant message is NOT persisted (matches Phase 02 behavior).

const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

type ExpandMode = 'none' | 'siblings' | 'sections' | 'auto';

// Phase 03 / OD-1 / OQ-1: the default is now `auto` (was `none` in
// Phase 02). Every chat runs the agent loop unless the caller
// explicitly overrides. Note: only `undefined` (or an unrecognised
// value) falls back to `auto`; explicit `none` stays `none`.
function parseExpandMode(value: string | undefined): ExpandMode {
  if (value === 'sections' || value === 'siblings' || value === 'auto' || value === 'none') return value;
  return 'auto';
}

function writeEvent(stream: NodeJS.WritableStream, event: string, data: unknown): void {
  stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// isUsableTitle — guards against the LLM returning its chain-of-thought
// instead of a title. Reject obvious reasoning-marker outputs (more than
// 12 words, contains quote-marks, or starts with the model's
// explanation prefix). Falls back to the 60-char user prefix (FR-15).
function isUsableTitle(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.length > 80) return false;
  const words = t.split(/\s+/).length;
  if (words > 12) return false;
  if (/^(The user|The assistant|User asked|Assistant answered|This is)/i.test(t)) return false;
  if (t.includes('"') && t.length > 50) return false;
  return true;
}

// Surface for the inner dispatcher. Both streamChatCompletion and
// streamAgentChat yield their own union types; we treat the agent
// loop's events as a superset and translate to SSE writes inline.
type DispatchSource =
  | { kind: 'agentic'; stream: AsyncGenerator<unknown> }
  | { kind: 'non-agentic'; stream: AsyncGenerator<StreamEvent> };

export async function chatStreamRoutes(fastify: FastifyInstance) {
  const db = (fastify as unknown as { db: DB }).db;
  const store = new ConversationStore(db);

  fastify.post('/api/chat/stream', async (request, reply) => {
    const body = request.body as {
      q?: string;
      sessionId?: string;
      limit?: string;
      expand?: string;
    };
    const { q, sessionId, limit, expand } = body;

    if (!q) {
      return reply.status(400).send({ error: 'Question "q" is required' });
    }

    let sid = sessionId;
    if (sid === undefined) {
      const created = store.create();
      sid = created.id;
    } else if (!SESSION_ID_REGEX.test(sid)) {
      return reply.status(400).send({ error: 'Invalid sessionId' });
    }
    const validSid = sid as string;

    // Tell Fastify the route handles the response itself. Without
    // hijack(), Fastify tries to send a default response after the
    // handler returns, which fails with ERR_HTTP_HEADERS_SENT once
    // we've already written SSE frames.
    reply.hijack();

    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.writeHead(200);
    reply.raw.flushHeaders();

    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());

    const userMessageId = uuidv4();
    const isFirstExchange = store.listMessages(validSid).length === 0;

    let fullText = '';
    let eventSources: Array<{
      fileName: string;
      filePath: string;
      chunk: string;
      pageNumber?: number;
      headingPath?: string[];
      score: number;
    }> = [];

    try {
      // Persist the user message immediately so the conversation
      // history reflects what was sent — even if the client
      // disconnects mid-stream.
      store.appendUserMessage(validSid, q);
      writeEvent(reply.raw, 'meta', { sessionId: validSid, userMessageId });

      const limitNum = Math.min(parseInt(limit || '5') || 5, 20);
      const expandMode = parseExpandMode(expand);

      const history = store
        .listMessages(validSid)
        .slice(-20) // CHAT_HISTORY_MAX_TURNS * 2 — keeps prompt bounded
        .map((m) => ({ role: m.role, content: m.content }));

      let assistantMessageId: string | undefined;
      const thinkFilter = createThinkFilter();

      // Phase 03 / p3-T08 — tool-call records captured from the
      // agentic SSE stream. Each `tool_call` event is paired with
      // its matching `tool_result` event (same `iteration` + order).
      const toolCallRecords: ToolCallRecord[] = [];
      let pendingToolCall: {
        name: string;
        arguments: Record<string, unknown>;
        iteration: number;
      } | null = null;

      // Tracks tool-retrieved chunks (kind: 'chunks' tool results)
      // so we can append them to the persisted sources field. The
      // agent loop surfaces chunks via `tool_result.result.chunks`;
      // we mirror them into eventSources.
      const toolSourceIds = new Set<string>();
      for (const s of eventSources) toolSourceIds.add(`${s.fileName}:${s.chunk}`);

      // The agentic source. When `expand=auto`, we drive the SSE
      // frame writes from the agent loop; when it yields
      // `tools_not_supported`, we swap to the non-agentic
      // streamChatCompletion(expand=none) without closing the
      // connection. (FR-22 / U11.)
      const isAuto = expandMode === 'auto';

      const dispatch: DispatchSource = isAuto
        ? {
            kind: 'agentic',
            stream: streamAgentChat(
              { question: q, sessionId: validSid, limit: limitNum, conversationHistory: history, db },
              ac.signal
            ) as AsyncGenerator<unknown>,
          }
        : {
            kind: 'non-agentic',
            stream: streamChatCompletion(
              { question: q, sessionId: validSid, conversationHistory: history, limit: limitNum, expandMode },
              ac.signal
            ),
          };

      let agenticDone = false;
      let activeDispatch = dispatch;

      while (true) {
        if (ac.signal.aborted) break;
        const next = await activeDispatch.stream.next();
        if (next.done) break;
        const ev = next.value as { type: string; [k: string]: unknown };

        if (ac.signal.aborted) break;

        if (activeDispatch.kind === 'agentic') {
          // ---- Agentic events (p3-T08) ----
          if (ev.type === 'token') {
            const text = ev.text as string;
            fullText += text;
            const visible = thinkFilter.push(text);
            if (visible) writeEvent(reply.raw, 'token', { text: visible });
          } else if (ev.type === 'sources') {
            const sources = ev.sources as Array<{
              id: string;
              payload: {
                fileName: string;
                filePath: string;
                chunk: string;
                pageNumber?: number;
                headingPath?: string[];
              };
              score?: number;
            }>;
            eventSources = sources.map((s) => ({
              fileName: s.payload.fileName,
              filePath: s.payload.filePath,
              chunk: s.payload.chunk,
              pageNumber: s.payload.pageNumber,
              headingPath: s.payload.headingPath,
              score: s.score ?? 0,
            }));
            toolSourceIds.clear();
            for (const s of eventSources) toolSourceIds.add(`${s.fileName}:${s.chunk}`);
            writeEvent(reply.raw, 'sources', eventSources);
          } else if (ev.type === 'tool_call') {
            pendingToolCall = {
              name: ev.name as string,
              arguments: (ev.arguments as Record<string, unknown>) ?? {},
              iteration: ev.iteration as number,
            };
            writeEvent(reply.raw, 'tool_call', {
              name: ev.name,
              arguments: pendingToolCall.arguments,
              iteration: pendingToolCall.iteration,
            });
          } else if (ev.type === 'tool_result') {
            // Pair with the most recent pending tool_call.
            const name = ev.name as string;
            const iteration = ev.iteration as number;
            const truncated = ev.truncated as boolean;
            const result = ev.result;
            if (pendingToolCall && pendingToolCall.iteration === iteration && pendingToolCall.name === name) {
              toolCallRecords.push({
                name,
                arguments: pendingToolCall.arguments,
                result,
                truncated,
                iteration,
              });
              pendingToolCall = null;
            } else {
              // Unpaired (defensive — shouldn't happen with a
              // well-behaved agent loop). Persist with empty args so
              // the record count matches.
              toolCallRecords.push({
                name,
                arguments: {},
                result,
                truncated,
                iteration,
              });
            }
            writeEvent(reply.raw, 'tool_result', {
              name,
              result,
              truncated,
              iteration,
            });
            // Aggregate chunks from this tool_result into the
            // persisted sources field (FR-19 / OD-6). Only chunks
            // we haven't seen from the initial retrieval.
            if (result && typeof result === 'object' && (result as { kind?: string }).kind === 'chunks') {
              const chunks = (result as { chunks: Array<{
                chunkId: string;
                fileName: string;
                filePath: string;
                chunkIndex: number;
                totalChunks?: number;
                pageNumber?: number;
                headingPath?: string[];
                text: string;
              }> }).chunks;
              for (const c of chunks ?? []) {
                const key = `${c.fileName}:${c.text}`;
                if (toolSourceIds.has(key)) continue;
                toolSourceIds.add(key);
                eventSources.push({
                  fileName: c.fileName,
                  filePath: c.filePath,
                  chunk: c.text,
                  pageNumber: c.pageNumber,
                  headingPath: c.headingPath,
                  score: 0,
                });
              }
            }
          } else if (ev.type === 'done') {
            const tail = thinkFilter.flush();
            if (tail) writeEvent(reply.raw, 'token', { text: tail });
            const persistedText = fullText
              .replace(/<think>[\s\S]*?<\/think>/g, '')
              .trim();
            if (!ac.signal.aborted && persistedText) {
              const stored = toolCallRecords.length > 0
                ? store.appendAssistantMessage(validSid, persistedText, eventSources, toolCallRecords)
                : store.appendAssistantMessage(validSid, persistedText, eventSources);
              assistantMessageId = stored.id;
            }
            writeEvent(reply.raw, 'done', {
              messageId: assistantMessageId,
              iterations: (ev.iterations as number) ?? 1,
            });
            agenticDone = true;
          } else if (ev.type === 'tools_not_supported') {
            // FR-22 / U11: the LLM provider rejected the tools
            // parameter. Fall back to the non-agentic path with
            // expand=none. We DON'T emit anything to the client
            // before swapping streams (the events that already
            // happened — sources — stay). tool_calls column stays
            // NULL.
            log.warn(
              { sessionId: validSid },
              'LLM does not support tools; falling back to expand=none'
            );
            try {
              await activeDispatch.stream.return(undefined);
            } catch {
              /* ignore */
            }
            fullText = '';
            eventSources = [];
            toolCallRecords.length = 0;
            pendingToolCall = null;
            activeDispatch = {
              kind: 'non-agentic',
              stream: streamChatCompletion(
                { question: q, sessionId: validSid, conversationHistory: history, limit: limitNum, expandMode: 'none' },
                ac.signal
              ),
            };
            // Loop continues; next iteration reads from the new dispatch.
          } else if (ev.type === 'error') {
            writeEvent(reply.raw, 'error', { message: ev.message as string });
          }
        } else {
          // ---- Non-agentic events (Phase 02 path) ----
          const phase02Ev = ev as StreamEvent;
          if (phase02Ev.type === 'token') {
            fullText += phase02Ev.text;
            const visible = thinkFilter.push(phase02Ev.text);
            if (visible) writeEvent(reply.raw, 'token', { text: visible });
          } else if (phase02Ev.type === 'sources') {
            eventSources = phase02Ev.sources.map((s) => ({
              fileName: s.payload.fileName,
              filePath: s.payload.filePath,
              chunk: s.payload.chunk,
              pageNumber: s.payload.pageNumber,
              headingPath: s.payload.headingPath,
              score: s.score ?? 0,
            }));
            writeEvent(reply.raw, 'sources', eventSources);
          } else if (phase02Ev.type === 'error') {
            writeEvent(reply.raw, 'error', { message: phase02Ev.message });
          } else if (phase02Ev.type === 'done') {
            const tail = thinkFilter.flush();
            if (tail) writeEvent(reply.raw, 'token', { text: tail });
            const persistedText = fullText
              .replace(/<think>[\s\S]*?<\/think>/g, '')
              .trim();
            if (!ac.signal.aborted && persistedText) {
              const stored = store.appendAssistantMessage(validSid, persistedText, eventSources);
              assistantMessageId = stored.id;
            }
            writeEvent(reply.raw, 'done', { messageId: assistantMessageId });
            agenticDone = true;
          }
        }
        if (agenticDone) break;
      }

      if (!ac.signal.aborted && isFirstExchange) {
        // Fire-and-forget title generator. The stream can already be
        // closed by the time this lands — writeEvent then becomes a
        // silent no-op on a closed socket.
        void (async () => {
          try {
            const llmTitle = await generateConversationTitle(q, fullText);
            if (isUsableTitle(llmTitle)) {
              const title = llmTitle.trim();
              const persisted = store.setGeneratedTitle(validSid, title);
              log.info({ title, persisted, sessionId: validSid }, 'LLM title persisted');
              if (persisted) {
                writeEvent(reply.raw, 'title', { sessionId: validSid, title });
              }
            } else {
              // LLM output was empty / chain-of-thought / too long.
              // Fall back to the 60-char user-prefix and mark
              // title_source = 'fallback' so a future LLM title can
              // still win (per FR-15b).
              const title = fallbackTitle(q);
              const persisted = store.setFallbackTitle(validSid, title);
              log.warn(
                { llmTitle, sessionId: validSid },
                'LLM title unusable; falling back to user-prefix'
              );
              if (persisted) {
                writeEvent(reply.raw, 'title', { sessionId: validSid, title });
              }
            }
          } catch (err) {
            log.warn({ err, sessionId: validSid }, 'Title LLM call failed, falling back');
            const title = fallbackTitle(q);
            const persisted = store.setFallbackTitle(validSid, title);
            if (persisted) {
              writeEvent(reply.raw, 'title', { sessionId: validSid, title });
            }
          } finally {
            reply.raw.end();
          }
        })();
      } else {
        reply.raw.end();
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      log.error({ err }, 'Chat stream route error');
      try {
        writeEvent(reply.raw, 'error', { message: 'Chat failed' });
      } catch {
        /* socket closed */
      }
      reply.raw.end();
    }
  });
}