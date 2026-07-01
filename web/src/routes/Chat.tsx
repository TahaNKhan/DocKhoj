import { useEffect, useState } from 'preact/hooks';
import { Sidebar } from '../components/Sidebar';
import { Bubble } from '../components/Bubble';
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

// Chat route — sidebar + chat area. T30 wires the SPA to
// /api/sessions; T33/T34 wire the SSE stream. The composer is wired
// to a no-op submit for now — sending through the stream is T34.

export function Chat() {
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  // On mount: load the session list, then either restore the active
  // session from localStorage or pick the most-recent (creating a new
  // one if none exist).
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
    };
  }, []);

  async function selectSession(id: string) {
    if (id === activeId) return;
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

          {!loading && messages.length === 0 && (
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
        </div>

        <Composer
          onSubmit={(text) => {
            /* T34 wires to POST /api/chat/stream. For now, surface
             * the intent so a manual smoke test in the browser is
             * possible. */
            console.log('chat submit (T34 will stream this):', text);
          }}
        />
      </div>
    </div>
  );
}