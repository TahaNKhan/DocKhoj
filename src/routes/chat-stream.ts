import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { ConversationStore } from '../services/conversations.js';
import { streamChatCompletion, type StreamEvent } from '../services/stream-chat.js';
import {
  generateConversationTitle,
  fallbackTitle,
} from '../services/title-generator.js';
import { chatLog as log } from '../utils/logger.js';
import type Database from 'better-sqlite3';

type DB = Database.Database;

// POST /api/chat/stream — Server-Sent Events chat endpoint (p2-p1-T12).
//
// Wire format (one SSE frame per event):
//   event: meta    data: { sessionId, userMessageId }
//   event: sources data: DocumentChunk[]
//   event: token   data: { text }
//   event: done    data: { messageId }
//   event: title   data: { sessionId, title }   (best-effort, post-done)
//   event: error   data: { message }
//
// Disconnect handling: when the client closes the connection,
// reply.raw.on('close') fires, the AbortController is aborted, and
// streamChatCompletion's underlying openai call is cancelled
// (FR-21). The partial assistant message is DISCARDED — we don't
// persist a half-finished answer.
//
// Title generation (FR-14/FR-15a): after `event: done` is emitted,
// the server fires generateConversationTitle asynchronously and
// emits `event: title` when it lands. If the client has already
// disconnected, the title is still persisted server-side; the
// SSE write to a closed socket is a no-op.

const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function parseExpandMode(value: string | undefined): 'none' | 'siblings' | 'sections' {
  if (value === 'sections' || value === 'siblings') return value;
  return 'none';
}

function writeEvent(stream: NodeJS.WritableStream, event: string, data: unknown): void {
  stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Stateful filter that hides `` chunks from the streamed token output
// (FR-20). The model emits `` as plain delta.content; we suppress
// everything between `<think>` and the next `</think>` and emit
// everything else. If the model splits a tag across two chunks, the
// filter still recovers as long as the closing `</think>` arrives.
function createThinkFilter() {
  let inside = false;
  let buf = '';
  return {
    push(text: string): string | null {
      buf += text;
      // Try to extract any user-visible content from the buffer.
      // When `` is open, hold everything until close.
      if (!inside && buf.includes('<think>')) {
        const idx = buf.indexOf('<think>');
        const before = buf.slice(0, idx);
        buf = buf.slice(idx);
        inside = true;
        return before || null;
      }
      if (inside && buf.includes('</think>')) {
        const idx = buf.indexOf('</think>') + '</think>'.length;
        buf = buf.slice(idx);
        inside = false;
        // After close, anything remaining in buf is visible — return it.
        const out = buf;
        buf = '';
        return out || null;
      }
      // No complete tag yet. If we're inside, withhold. Otherwise
      // flush, but hold a small tail in case the next chunk starts
      // a tag.
      if (inside) return null;
      // Hold back the last 8 chars in case a partial <think> straddles
      // the chunk boundary.
      const tail = Math.min(8, buf.length);
      const out = buf.slice(0, buf.length - tail);
      buf = buf.slice(buf.length - tail);
      return out || null;
    },
    flush(): string | null {
      // Stream is closing. Whatever's in the buffer that isn't inside a
      // think tag is visible — return it.
      if (inside || !buf) return null;
      const out = buf;
      buf = '';
      return out;
    },
  };
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

      for await (const ev of streamChatCompletion(
        { question: q, sessionId: validSid, conversationHistory: history, limit: limitNum, expandMode },
        ac.signal
      )) {
        if (ac.signal.aborted) break;
        if (ev.type === 'token') {
          fullText += ev.text;
          const visible = thinkFilter.push(ev.text);
          if (visible) writeEvent(reply.raw, 'token', { text: visible });
        } else if (ev.type === 'sources') {
          eventSources = ev.sources.map((s) => ({
            fileName: s.payload.fileName,
            filePath: s.payload.filePath,
            chunk: s.payload.chunk,
            pageNumber: s.payload.pageNumber,
            headingPath: s.payload.headingPath,
            score: s.score ?? 0,
          }));
          writeEvent(reply.raw, 'sources', eventSources);
        } else if (ev.type === 'error') {
          writeEvent(reply.raw, 'error', { message: ev.message });
        } else if (ev.type === 'done') {
          // Flush any buffered visible text before closing the stream.
          const tail = thinkFilter.flush();
          if (tail) writeEvent(reply.raw, 'token', { text: tail });
          // Strip think tags from the persisted assistant message —
          // the persisted DB record must not contain reasoning.
          const persistedText = fullText
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .trim();
          if (!ac.signal.aborted && persistedText) {
            const stored = store.appendAssistantMessage(validSid, persistedText, eventSources);
            assistantMessageId = stored.id;
          }
          writeEvent(reply.raw, 'done', { messageId: assistantMessageId });
        }
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