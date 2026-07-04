import { useEffect, useRef, useState } from 'preact/hooks';
import { Route, Switch, Redirect, useLocation } from 'wouter-preact';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { RouteGuard } from './components/RouteGuard';
import { Chat, type PendingTurn } from './routes/Chat';
import { Upload } from './routes/Upload';
import { Login } from './routes/Login';
import { Register } from './routes/Register';
import { InviteAccept } from './routes/InviteAccept';
import { AdminUsers } from './routes/AdminUsers';
import { AdminInvites } from './routes/AdminInvites';
import { AuthProvider, useAuth } from './hooks/useAuth';
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
import { fetchStatus, type ServerStatus } from './services/status';
import { fetchAuthStatus } from './services/auth';
import type { Source } from './components/Bubble';
import type { ToolCallRecord } from './types';

// App — top-level chrome (background layers, TopBar, layout split).
// Session state lives here (not inside the chat route) so the Sidebar
// can sit alongside Chat in the page-level layout, the way the box
// model wants it: body → TopBar → <main class="layout"> → [Sidebar, Chat].
//
// Upload is a single-column route, so on /upload the Sidebar is
// omitted from <main> entirely — no `display: none` games.
//
// p4-T16: AuthProvider is mounted at the top so every page can read
// the auth state. The initial `/` route is a small redirector
// (RootRedirect) that reads useAuth and decides where to send the
// user: authenticated → /chat; else first-user-available → /register;
// else /login.

export function App() {
  return (
    <AuthProvider>
      <Chrome />
    </AuthProvider>
  );
}

function Chrome() {
  const [location, setLocation] = useLocation();
  const isChatRoute = location === '/' || location.startsWith('/chat');
  const isUploadRoute = location.startsWith('/upload');

  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const streamRef = useRef<{ close: () => void } | null>(null);

  // p2-T23 follow-up: mobile sidebar (burger menu). The sidebar slides in
  // as a fixed overlay below 960 px (see sidebar.css). On desktop the
  // state is irrelevant — the sidebar is always visible — but we still
  // keep it in state so the same component instance works on both.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close the sidebar whenever the route changes (user clicked Chat /
  // Upload, picked a session, etc.). Without this the overlay would
  // linger over the new page.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location]);

  // Escape closes the sidebar when it's open.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  // Poll /api/status every 5s for the TopBar pill (chunk count +
  // Ollama reachability) and the chat toolbar's model pill (LLM_MODEL
  // + the probed context size). The poll lives at App level so both
  // components read from a single source.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await fetchStatus();
        if (!cancelled) setStatus(next);
      } catch {
        // Network blip — leave the last known status on screen.
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, 5_000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // Load the session list on mount so the sidebar has data on every
  // route that renders it (chat, upload). On the chat route we also
  // restore the active session from localStorage (or create one) and
  // load its messages.
  useEffect(() => {
    const needsSessions = isChatRoute || isUploadRoute;
    if (!needsSessions) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listSessions();
        if (cancelled) return;
        setSessions(list);

        if (isChatRoute) {
          const stored = loadActiveSessionId();
          let target: Conversation | undefined;
          if (stored && list.find((s) => s.id === stored)) {
            target = list.find((s) => s.id === stored);
          } else if (list.length > 0) {
            target = list[0];
          } else {
            const created = await createSession();
            list.push(created);
            target = created;
          }
          if (!target) return;
          if (cancelled) return;
          saveActiveSessionId(target.id);
          setActiveId(target.id);
          const msgs = await listMessages(target.id);
          if (!cancelled) setMessages(msgs);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (!isChatRoute) streamRef.current?.close();
    };
  }, [isChatRoute, isUploadRoute]);

  async function selectSession(id: string) {
    if (id === activeId && isChatRoute) return;
    streamRef.current?.close();
    setPending(null);
    saveActiveSessionId(id);
    setActiveId(id);
    setMessages([]);
    const msgs = await listMessages(id);
    setMessages(msgs);
    setSidebarOpen(false);
    // If we're not on the chat page, navigate there so the user sees
    // the conversation they just selected.
    if (!isChatRoute) setLocation('/chat');
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

  function handleSubmit(text: string, options?: { expand?: string }) {
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

    const expand = options?.expand ?? 'auto';

    let acc = '';
    // Local tool-call accumulator (p3-T09). The agent loop pairs
    // `tool_call` (BEFORE execution) with `tool_result` (AFTER). We
    // stash pending calls here and attach the result when the
    // matching `tool_result` arrives.
    let pendingToolCalls: Partial<ToolCallRecord>[] = [];
    streamRef.current = openChatStream(
      { q: text, sessionId: activeId, expand },
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
                      filePath: s.filePath,
                      page: s.pageNumber ? `p.${s.pageNumber}` : undefined,
                      pageNumber: s.pageNumber,
                      headingPath: s.headingPath,
                      chunk: s.chunk,
                      score: s.score,
                    })),
                  }
                : p
            );
          } else if (ev.type === 'token') {
            acc += ev.text;
            setPending((p) => (p ? { ...p, aiText: acc } : p));
          } else if (ev.type === 'tool_call') {
            pendingToolCalls.push({
              name: ev.name,
              arguments: ev.arguments,
              iteration: ev.iteration,
            });
            setPending((p) =>
              p ? { ...p, toolCalls: pendingToolCalls.slice() as ToolCallRecord[] } : p
            );
          } else if (ev.type === 'tool_result') {
            // Attach the result to the most-recent pending call
            // (the route handler emits them in pairs; we trust the
            // order).
            const last = pendingToolCalls[pendingToolCalls.length - 1];
            if (last && last.name === ev.name) {
              last.result = ev.result;
              last.truncated = ev.truncated;
            }
            setPending((p) =>
              p ? { ...p, toolCalls: pendingToolCalls.slice() as ToolCallRecord[] } : p
            );
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
            // server-assigned id and the persisted toolCalls column).
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

  // The TopBar + <main> chrome is only painted for auth-required
  // routes. The login / register pages render their own layout and
  // don't want the TopBar's pill row (no session to show anyway).
  const isAuthPage =
    location === '/login' ||
    location === '/register' ||
    location.startsWith('/register/');

  return (
    <>
      {!isAuthPage && (
        <>
          <div class="aurora" aria-hidden="true" />
          <div class="grain" aria-hidden="true" />
          <div class="grid-overlay" aria-hidden="true" />

          <TopBar
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            status={status}
          />
        </>
      )}

      <main class={!isAuthPage && (isChatRoute || isUploadRoute) ? 'layout' : ''}>
        {!isAuthPage && (isChatRoute || isUploadRoute) && (
          <>
            <Sidebar
              sessions={sessions}
              activeId={activeId}
              open={sidebarOpen}
              onClose={() => setSidebarOpen(false)}
              onSelect={selectSession}
              onCreate={handleCreate}
              onRename={handleRename}
              onDelete={handleDelete}
            />
            {/* Scrim sits inside <main> on mobile (the sidebar is a
                fixed-position overlay there). On desktop it's hidden
                via display: none in sidebar.css. */}
            <div
              class={`side-scrim${sidebarOpen ? ' open' : ''}`}
              onClick={() => setSidebarOpen(false)}
              aria-hidden="true"
            />
          </>
        )}

        <Switch>
          <Route path="/">
            <RootRedirect />
          </Route>
          <Route path="/login">
            <Login />
          </Route>
          <Route path="/register">
            <Register />
          </Route>
          <Route path="/register/:token">
            <InviteAccept />
          </Route>
          <Route path="/chat">
            <RouteGuard>
              <Chat
                activeSession={activeSession}
                loading={loading}
                messages={messages}
                pending={pending}
                onSubmit={handleSubmit}
                status={status}
              />
            </RouteGuard>
          </Route>
          <Route path="/upload">
            <RouteGuard>
              <Upload />
            </RouteGuard>
          </Route>
          <Route path="/admin/users">
            <RouteGuard requireRole="admin">
              <AdminUsers />
            </RouteGuard>
          </Route>
          <Route path="/admin/invites">
            <RouteGuard requireRole="admin">
              <AdminInvites />
            </RouteGuard>
          </Route>
        </Switch>
      </main>
    </>
  );
}

// RootRedirect — the SPA's initial `/` route. Reads useAuth and
// sends the visitor to /chat (authenticated) or /register
// (first-user) or /login (everything else).
function RootRedirect() {
  const { user, status } = useAuth();
  const [firstUserAvailable, setFirstUserAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (status !== 'anonymous') return;
    let cancelled = false;
    fetchAuthStatus()
      .then((s) => {
        if (!cancelled) setFirstUserAvailable(s.firstUserAvailable);
      })
      .catch(() => {
        if (!cancelled) setFirstUserAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  if (status === 'loading') return null;

  if (status === 'authenticated' && user) {
    return <Redirect to="/chat" />;
  }

  if (firstUserAvailable === null) {
    return <div class="route-loading">Loading…</div>;
  }

  return <Redirect to={firstUserAvailable ? '/register' : '/login'} />;
}