import { Bubble, type Source } from '../components/Bubble';
import { Composer } from '../components/Composer';
import type { Conversation, Message } from '../services/sessions';

// Chat — presentational route. Owns no state; the parent (<App>)
// holds sessions, messages, and the streaming turn, and passes them
// in. Renders the chat column: toolbar / stream / composer.

export interface PendingTurn {
  userMessageId: string;
  userText: string;
  aiText: string;
  aiStreaming: boolean;
  sources: Source[];
  errorMessage?: string;
}

interface Props {
  activeSession: Conversation | null;
  loading: boolean;
  messages: Message[];
  pending: PendingTurn | null;
  onSubmit: (text: string) => void;
}

export function Chat({ activeSession, loading, messages, pending, onSubmit }: Props) {
  return (
    <section class="chat">
      <div class="toolbar">
        <div class="crumb">
          Session <i>/</i>{' '}
          <b>{activeSession?.title ?? (loading ? 'loading…' : 'No session')}</b>
        </div>
        <div class="model">
          <span class="sw" />
          <span>llama-3.1 · 8k ctx</span>
          <span class="car">▾</span>
        </div>
      </div>

      <div class="stream">
        {loading && (
          <div class="bubble ai" style={{ opacity: 0.6 }}>
            <div class="who">
              <b>DocKhoj</b>
              <span class="dot" />
              just now
            </div>
            <div class="text">Loading session…</div>
          </div>
        )}

        {!loading && messages.length === 0 && !pending && (
          <div class="bubble ai" style={{ opacity: 0.6 }}>
            <div class="who">
              <b>DocKhoj</b>
              <span class="dot" />
              just now
            </div>
            <div class="text">
              Send a question to begin. I'll search across your indexed
              documents and stream back an answer with citations.
            </div>
          </div>
        )}

        {messages.map((m) => (
          <Bubble
            key={m.id}
            role={m.role}
            text={m.content}
            timestamp={m.createdAt.replace(' ', 'T').slice(11, 16)}
            sources={
              m.sources?.map((s, i) => ({
                id: `${m.id}-${i}`,
                number: i + 1,
                fileName: s.fileName,
                page: s.pageNumber ? `p.${s.pageNumber}` : undefined,
              })) ?? []
            }
          />
        ))}

        {pending && (
          <Bubble
            key={`pending-${pending.userMessageId || 'pending'}`}
            role="assistant"
            text={pending.aiText || (pending.aiStreaming ? 'Thinking' : '')}
            streaming={pending.aiStreaming}
            sources={pending.sources}
            timestamp="just now"
          />
        )}
      </div>

      <Composer disabled={pending?.aiStreaming} onSubmit={onSubmit} />
    </section>
  );
}