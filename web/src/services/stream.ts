// Client-side SSE consumer for /api/chat/stream.
//
// Native EventSource doesn't support POST with a body, so we use
// fetch + ReadableStream and parse the wire format ourselves. The
// wire format is one SSE frame per event:
//   event: <name>\ndata: <json>\n\n
//
// The parser buffers partial frames so a chunked transfer is fine.
//
// Phase 03 / p3-T09 — added `event: tool_call` and
// `event: tool_result` to the recognized event set. Both carry the
// `iteration` field for ordering; the SPA renders each as a chip
// below the assistant bubble when `toolCalls` is present.

export interface StreamSource {
  fileName: string;
  filePath: string;
  chunk: string;
  pageNumber?: number;
  headingPath?: string[];
  score: number;
}

export type StreamEvent =
  | { type: 'meta'; sessionId: string; userMessageId: string }
  | { type: 'sources'; sources: StreamSource[] }
  | { type: 'token'; text: string }
  | {
      type: 'tool_call';
      name: string;
      arguments: Record<string, unknown>;
      iteration: number;
    }
  | {
      type: 'tool_result';
      name: string;
      result: unknown;
      truncated: boolean;
      iteration: number;
    }
  | { type: 'done'; messageId?: string; iterations?: number }
  | { type: 'title'; sessionId: string; title: string }
  | { type: 'error'; message: string };

export interface ChatStreamHandlers {
  onEvent: (ev: StreamEvent) => void;
  onError?: (e: unknown) => void;
  onClose?: () => void;
}

export function openChatStream(
  body: { q: string; sessionId?: string; limit?: number; expand?: string },
  handlers: ChatStreamHandlers
): { close: () => void } {
  const ac = new AbortController();
  fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: ac.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        handlers.onError?.(new Error(`HTTP ${res.status}`));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          let type = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            handlers.onEvent({ type, ...parsed } as StreamEvent);
          } catch {
            // malformed frame — skip per FR tolerance
          }
        }
      }
      handlers.onClose?.();
    })
    .catch((e) => {
      if (e?.name !== 'AbortError') handlers.onError?.(e);
    });
  return { close: () => ac.abort() };
}
