import { useEffect, useRef, useState } from 'preact/hooks';
import { Sidebar } from '../components/Sidebar';
import { Bubble, type Source } from '../components/Bubble';
import { Composer } from '../components/Composer';
import {
  listSessions,
  getSession,
  createSession,
  listMessages,
  renameSession,
  deleteSession,
  loadActiveSessionId,
  saveActiveSessionId,
  type Conversation,
  type Message,
} from '../services/sessions';
import { openChatStream, type StreamSource } from '../services/stream';

// Chat route — sidebar + chat area. Wires the streaming
// /api/chat/stream endpoint so user input returns live tokens.

interface PendingTurn {
  userMessageId: string;
  userText: string;
  aiText: string;
  aiStreaming: boolean;
  sources: Source[];
  errorMessage?: string;
}

export function Chat() {
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const streamRef = useRef<{ close: () => void } | null>(null);

  // On mount: load the session list, then restore the active
  // session from localStorage (or pick the most-recent, creating a
  // new one if none exist).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let list = await listSessions();
        if (cancelled) return;

        const stored = loadActiveSessionId();
        let target: Conversation | undefined;
        if (stored && list.find((s) => s.id === stored)) {
          target = list.find((s) => s.id === stored);
        } else if (list.length > 0) {
          target = list[0];
        } else {
          const created = await createSession();
          list = [created, ...list];
          target = created;
        }
        if (!target) return;
        if (cancelled) return;
        saveActiveSessionId(target.id);
        setSessions(list);
        setActiveId(target.id);
        const msgs = await listMessages(target.id);
        if (!cancelled) setMessages(msgs);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.close();
    };
  }, []);

  async function selectSession(id: string) {
    if (id === activeId) return;
    streamRef.current?.close();
    setPending(null);
    saveActiveSessionId(id);
    setActiveId(id);
    setMessages([]);
    const msgs = await listMessages(id);
    setMessages(msgs);
  }

  async function handleCreate() {
    const created = await createSession();
    setSessions((s) => [created, ...s]);
    selectSession(created.id);
  }

  async function handleRename(id: string, currentTitle: string) {
    const next = window.prompt('Rename session', currentTitle);
    if (!next || next.trim() === currentTitle) return;
    const updated = await renameSession(id, next.trim());
    setSessions((list) => list.map((s) => (s.id === id ? updated : s)));
  }

  async function handleDelete(id: string) {
    await deleteSession(id);
    setSessions((list) => list.filter((s) => s.id !== id));
    if (activeId === id) {
      const next = sessions.find((s) => s.id !== id);
      if (next) {
        selectSession(next.id);
      } else {
        setActiveId(null);
        setMessages([]);
        handleCreate();
      }
    }
  }

  function handleSubmit(text: string) {
    if (!activeId) return;
    // Cancel any in-flight stream — one chat at a time.
    streamRef.current?.close();
    // Optimistic UI: show the user bubble immediately, the AI bubble
    // with a "thinking…" caret that the stream will overwrite.
    const optimisticUser: Message = {
      id: `optimistic-user-${Date.now()}`,
      conversationId: activeId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    setPending({
      userMessageId: '',
      userText: text,
      aiText: '',
      aiStreaming: true,
      sources: [],
    });

    let acc = '';
    streamRef.current = openChatStream(
      { q: text, sessionId: activeId },
      {
        onEvent: (ev) => {
          if (ev.type === 'meta') {
            setPending((p) => (p ? { ...p, userMessageId: ev.userMessageId } : p));
          } else if (ev.type === 'sources') {
            setPending((p) =>
              p
                ? {
                    ...p,
                    sources: ev.sources.map((s: StreamSource, i: number) => ({
                      id: `${ev.sessionId}-${i}`,
                      number: i + 1,
                      fileName: s.fileName,
                      page: s.pageNumber ? `p.${s.pageNumber}` : undefined,
                    })),
                  }
                : p
            );
          } else if (ev.type === 'token') {
            acc += ev.text;
            setPending((p) => (p ? { ...p, aiText: acc } : p));
          } else if (ev.type === 'title') {
            // Update the sidebar in-place.
            setSessions((list) =>
              list.map((s) => (s.id === ev.sessionId ? { ...s, title: ev.title } : s))
            );
          } else if (ev.type === 'error') {
            setPending((p) =>
              p ? { ...p, aiStreaming: false, errorMessage: ev.message } : p
            );
          } else if (ev.type === 'done') {
            // Refresh history from the server so the optimistic user
            // bubble is replaced with the canonical one (with the
            // server-assigned id).
            setPending(null);
            if (activeId) {
              listMessages(activeId).then((msgs) => setMessages(msgs));
            }
          }
        },
        onError: () => {
          setPending((p) =>
            p ? { ...p, aiStreaming: false, errorMessage: 'Stream failed' } : p
          );
        },
      }
    );
  }

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div class="chat-shell">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={selectSession}
        onCreate={handleCreate}
        onRename={handleRename}
        onDelete={handleDelete}
      />

      <div class="area">
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

        <Composer
          disabled={pending?.aiStreaming}
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  );
}