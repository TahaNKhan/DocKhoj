import { useEffect, useRef, useState } from 'preact/hooks';
import { Route, Switch, Redirect, useLocation } from 'wouter-preact';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Chat, type PendingTurn } from './routes/Chat';
import { Upload } from './routes/Upload';
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
} from './services/sessions';
import { openChatStream, type StreamSource } from './services/stream';
import type { Source } from './components/Bubble';

// App — top-level chrome (background layers, TopBar, layout split).
// Session state lives here (not inside the chat route) so the Sidebar
// can sit alongside Chat in the page-level layout, the way the box
// model wants it: body → TopBar → <main class="layout"> → [Sidebar, Chat].
//
// Upload is a single-column route, so on /upload the Sidebar is
// omitted from <main> entirely — no `display: none` games.

export function App() {
  const [location] = useLocation();
  const isChatRoute = location === '/' || location.startsWith('/chat');

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
    if (!isChatRoute) return;
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
  }, [isChatRoute]);

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
    <>
      <div class="aurora" aria-hidden="true" />
      <div class="grain" aria-hidden="true" />
      <div class="grid-overlay" aria-hidden="true" />

      <TopBar />

      <main class={isChatRoute ? 'layout' : ''}>
        {isChatRoute && (
          <Sidebar
            sessions={sessions}
            activeId={activeId}
            onSelect={selectSession}
            onCreate={handleCreate}
            onRename={handleRename}
            onDelete={handleDelete}
          />
        )}

        <Switch>
          <Route path="/">
            <Redirect to="/chat" />
          </Route>
          <Route path="/chat">
            <Chat
              activeSession={activeSession}
              loading={loading}
              messages={messages}
              pending={pending}
              onSubmit={handleSubmit}
            />
          </Route>
          <Route path="/upload">
            <Upload />
          </Route>
        </Switch>
      </main>
    </>
  );
}