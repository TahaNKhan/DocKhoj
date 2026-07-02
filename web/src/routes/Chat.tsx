import { useEffect, useRef, useState } from 'preact/hooks';
import { Bubble, type Source } from '../components/Bubble';
import { Composer } from '../components/Composer';
import { SourceDrawer } from '../components/SourceDrawer';
import type { Conversation, Message } from '../services/sessions';
import type { ServerStatus } from '../services/status';
import { formatContextSize } from '../services/status';

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
  status: ServerStatus | null;
}

export function Chat({ activeSession, loading, messages, pending, onSubmit, status }: Props) {
  // T37 — Source drawer state. The drawer is mounted while a source
  // is selected; clicking a chip on any assistant bubble (committed
  // history or live stream) sets `openSource` and the drawer slides
  // in from the right. ESC + backdrop click + the × button all close
  // it. Living in Chat.tsx (not App.tsx) because the drawer is a
  // chat-column affordance — it shouldn't appear over /upload.
  const [openSource, setOpenSource] = useState<Source | null>(null);

  // Model pill: show the configured chat model + its probed context
  // size (e.g. "gpt-4o · 128k ctx"). While /api/status is still being
  // polled we render an em-dash so the pill width stays stable.
  const modelLabel = status ? status.llmModel : '—';
  const ctxLabel = status?.llmContextSize != null
    ? `${formatContextSize(status.llmContextSize)} ctx`
    : null;

  // T49 — scroll the stream to the bottom on session load (initial
  // mount + session switch). Two guards:
  //
  //   1. `messages.length === 0` — the active session may have just
  //      switched but its messages haven't loaded yet; bail and let
  //      the next effect run (when the fetch completes) do the scroll.
  //      Without this, we'd update lastScrolledFor while the stream
  //      is empty and miss the real scroll when messages arrive.
  //
  //   2. `lastScrolledFor.current === id` — once we've jumped to the
  //      bottom for a session we leave the user's scroll position
  //      alone. Token streaming grows `messages.length` but doesn't
  //      change the session id, so this guard naturally ignores it —
  //      that's intentional, see T49 in TASKS.md.
  //
  // We use `behavior: 'auto'` (instant) rather than letting the
  // container's `scroll-behavior: smooth` animate the jump; a
  // programmatic jump on load should land without a visible tween.
  // The rAF gives Preact one paint to commit the new message nodes
  // before we measure scrollHeight.
  const streamRef = useRef<HTMLDivElement>(null);
  const lastScrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const id = activeSession?.id;
    if (!id) return;
    if (messages.length === 0) return;
    if (lastScrolledFor.current === id) return;
    lastScrolledFor.current = id;
    requestAnimationFrame(() => {
      const live = streamRef.current;
      if (!live) return;
      live.scrollTo({ top: live.scrollHeight, behavior: 'auto' });
    });
  }, [activeSession?.id, messages.length]);

  return (
    <section class="chat">
      <div class="toolbar">
        <div class="crumb">
          Session <i>/</i>{' '}
          <b>{activeSession?.title ?? (loading ? 'loading…' : 'No session')}</b>
        </div>
        <div class="model" aria-live="polite">
          <span class="sw" />
          <span>
            {modelLabel}
            {ctxLabel && (
              <>
                {' · '}
                {ctxLabel}
              </>
            )}
          </span>
          <span class="car">▾</span>
        </div>
      </div>

      <div class="stream" ref={streamRef}>
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
                filePath: s.filePath,
                page: s.pageNumber ? `p.${s.pageNumber}` : undefined,
                pageNumber: s.pageNumber,
                headingPath: s.headingPath,
                chunk: s.chunk,
                score: s.score,
              })) ?? []
            }
            onSourceClick={setOpenSource}
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
            onSourceClick={setOpenSource}
          />
        )}
      </div>

      <Composer disabled={pending?.aiStreaming} onSubmit={onSubmit} />
      <SourceDrawer source={openSource} onClose={() => setOpenSource(null)} />
    </section>
  );
}