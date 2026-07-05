import { useEffect, useRef, useState } from 'preact/hooks';
import { Bubble, type DocSourceGroup, type Source } from '../components/Bubble';
import { Composer } from '../components/Composer';
import { SourceDrawer } from '../components/SourceDrawer';
import { DocSourceDrawer } from '../components/DocSourceDrawer';
import type { Conversation, Message } from '../services/sessions';
import type { ServerStatus } from '../services/status';
import { formatContextSize } from '../services/status';
import type { ToolCallRecord } from '../types';
import { AnimatedTitle } from '../components/AnimatedTitle';

// Chat — presentational route. Owns no state; the parent (<App>)
// holds sessions, messages, and the streaming turn, and passes them
// in. Renders the chat column: toolbar / stream / composer.
//
// Phase 03 / p3-T10 — expand-mode toggle. Chat owns the mode and
// persists it to localStorage under `dockhoj.expandMode`. The mode is
// passed to onSubmit so App includes it in the next stream's body.
// Default is `auto` per OD-1 / OQ-1.

export interface PendingTurn {
  userMessageId: string;
  userText: string;
  aiText: string;
  aiStreaming: boolean;
  sources: Source[];
  toolCalls?: ToolCallRecord[];
  errorMessage?: string;
}

export type ExpandMode = 'none' | 'siblings' | 'sections' | 'auto';

const EXPAND_OPTIONS: Array<{ value: ExpandMode; label: string; description: string }> = [
  { value: 'none', label: 'None', description: 'no expansion (fastest)' },
  { value: 'siblings', label: 'Siblings', description: '±2 chunks (fast)' },
  { value: 'sections', label: 'Sections', description: 'full section (medium)' },
  { value: 'auto', label: 'Auto', description: 'agentic (slowest, best answers)' },
];

const STORAGE_KEY = 'dockhoj.expandMode';

function loadInitialMode(): ExpandMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'none' || raw === 'siblings' || raw === 'sections' || raw === 'auto') {
      return raw;
    }
  } catch {
    /* private mode / storage disabled */
  }
  return 'auto';
}

function saveMode(mode: ExpandMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* noop */
  }
}

interface Props {
  activeSession: Conversation | null;
  loading: boolean;
  messages: Message[];
  pending: PendingTurn | null;
  onSubmit: (text: string, options: { expand: ExpandMode }) => void;
  status: ServerStatus | null;
}

export function Chat({ activeSession, loading, messages, pending, onSubmit, status }: Props) {
  // p2-T16 — Source drawer state. The drawer is mounted while a source
  // is selected; clicking a chip on any assistant bubble (committed
  // history or live stream) sets `openSource` and the drawer slides
  // in from the right. ESC + backdrop click + the × button all close
  // it. Living in Chat.tsx (not App.tsx) because the drawer is a
  // chat-column affordance — it shouldn't appear over /upload.
  const [openSource, setOpenSource] = useState<Source | null>(null);

  // p3-T18 — DocSourceDrawer state. When a Bubble renders grouped
  // source chips (one per file), clicking a chip hands us the whole
  // group via onDocSourceClick. The DocSourceDrawer then lists the
  // file's chunks and renders the active chunk's markdown. Exactly
  // one of openSource / openDocSources is non-null at a time.
  const [openDocSources, setOpenDocSources] = useState<DocSourceGroup | null>(null);

  // p3-T10 — expand-mode toggle state. Default 'auto' (Phase 03
  // behavior change from Phase 02's 'none' default — documented in
  // README.md as a breaking behavior change).
  const [expandMode, setExpandMode] = useState<ExpandMode>(loadInitialMode);
  const [modePopoverOpen, setModePopoverOpen] = useState(false);

  function selectMode(mode: ExpandMode) {
    setExpandMode(mode);
    saveMode(mode);
    setModePopoverOpen(false);
  }

  // Close the popover on outside click.
  const modeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modePopoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) {
        setModePopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [modePopoverOpen]);

  const modeLabel = EXPAND_OPTIONS.find((o) => o.value === expandMode)?.label ?? 'Auto';

  function handleSubmit(text: string) {
    onSubmit(text, { expand: expandMode });
  }

  // Model pill: show the configured chat model + its probed context
  // size (e.g. "gpt-4o · 128k ctx"). While /api/status is still being
  // polled we render an em-dash so the pill width stays stable.
  const modelLabel = status ? status.llmModel : '—';
  const ctxLabel = status?.llmContextSize != null
    ? `${formatContextSize(status.llmContextSize)} ctx`
    : null;

  // p2-T26 — scroll the stream to the bottom on session load (initial
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
  //      that's intentional, see p2-T26 in
  //      docs/specs/phase-02-frontend-streaming-and-persistence/TASKS.md.
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
          <b>
            {activeSession?.title != null
              ? <AnimatedTitle text={activeSession.title} />
              : (loading ? 'loading…' : 'No session')}
          </b>
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
        <div class="expand-toggle" ref={modeRef}>
          <button
            class={`mode-chip mode-${expandMode}`}
            aria-haspopup="listbox"
            aria-expanded={modePopoverOpen}
            onClick={() => setModePopoverOpen((v) => !v)}
          >
            <span class="mode-chip-label">{modeLabel}</span>
            <span class="caret">▾</span>
          </button>
          {modePopoverOpen && (
            <div class="mode-popover" role="listbox">
              {EXPAND_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  role="option"
                  aria-selected={opt.value === expandMode}
                  class={opt.value === expandMode ? 'selected' : ''}
                  onClick={() => selectMode(opt.value)}
                >
                  <span class="mode-name">{opt.label}</span>
                  <span class="mode-desc">— {opt.description}</span>
                </button>
              ))}
            </div>
          )}
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
            toolCalls={m.toolCalls}
            onSourceClick={setOpenSource}
            onDocSourceClick={setOpenDocSources}
          />
        ))}

        {pending && (
          <Bubble
            key={`pending-${pending.userMessageId || 'pending'}`}
            role="assistant"
            text={pending.aiText || (pending.aiStreaming ? 'Thinking' : '')}
            streaming={pending.aiStreaming}
            sources={pending.sources}
            toolCalls={pending.toolCalls}
            timestamp="just now"
            onSourceClick={setOpenSource}
            onDocSourceClick={setOpenDocSources}
          />
        )}
      </div>

      <Composer disabled={pending?.aiStreaming} onSubmit={handleSubmit} />
      <SourceDrawer source={openSource} onClose={() => setOpenSource(null)} />
      <DocSourceDrawer
        docSources={openDocSources}
        onClose={() => setOpenDocSources(null)}
      />
    </section>
  );
}