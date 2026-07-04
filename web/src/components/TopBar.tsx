import { useState, useEffect } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import type { ServerStatus } from '../services/status';
import { useAuth } from '../hooks/useAuth';
import { UserMenu } from './UserMenu';
import { setTheme, getStoredTheme, applyTheme } from '../services/theme';

// TopBar — brand mark + burger (mobile) + nav pills + status indicator.
// The status pill is fed by /api/status (polled in App): it shows the
// live chunk count from Qdrant and reflects Ollama reachability. While
// the first poll is in flight we render an em-dash so the layout
// doesn't jump.
//
// p4-T17 — the right-hand cluster (status pill + UserMenu) is wrapped
// in .topright so the UserMenu chip lands next to the status pill when
// the user is authenticated. UserMenu returns null while the auth
// state is still loading or the visitor is anonymous, so the chip
// doesn't flicker before RouteGuard bounces them to /login.

type Theme = 'dark' | 'light';

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  status: ServerStatus | null;
}

export function TopBar({ sidebarOpen, onToggleSidebar, status }: Props) {
  const [path] = useLocation();
  const { status: authStatus } = useAuth();
  const isChat = path === '/' || path.startsWith('/chat');
  const isUpload = path.startsWith('/upload');
  const showUserMenu = authStatus === 'authenticated';

  const [theme, setThemeState] = useState<Theme>(getStoredTheme());

  // sync the <html> data-theme attribute every render (catches live
  // OS-preference changes that the main.tsx listener applies).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // re-read from storage when the OS-preference listener in main.tsx
  // fires (it calls applyTheme but doesn't set our local state).
  useEffect(() => {
    const handler = () => {
      if (!localStorage.getItem('dockhoj:theme')) {
        setThemeState(getStoredTheme());
      }
    };
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', handler);
    return () =>
      window.matchMedia('(prefers-color-scheme: light)').removeEventListener('change', handler);
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  }

  const reachable = status?.ollamaAvailable ?? null;
  const chunks = status?.chunks;
  const chunksLabel = chunks === undefined
    ? '—'
    : chunks.toLocaleString('en-US');

  return (
    <header class="topbar">
      <button
        type="button"
        class={`burger${sidebarOpen ? ' open' : ''}`}
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? 'Close sessions' : 'Open sessions'}
        aria-expanded={sidebarOpen}
        aria-controls="sidebar"
      >
        <span class="bar" />
        <span class="bar" />
        <span class="bar" />
      </button>

      <div class="brand">
        <span class="brand-mark" />
        <span class="brand-name">
          DocKhoj<i>.</i>
        </span>
      </div>

      <nav class="topnav">
        <Link href="/chat" class={isChat ? 'active' : ''}>
          Chat
        </Link>
        <Link href="/upload" class={isUpload ? 'active' : ''}>
          Upload
        </Link>
      </nav>

      <div class="topright">
        <button
          type="button"
          class="theme-toggle"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '\u2600' : '\u263E'}
        </button>
        <div class="topmeta" aria-live="polite">
          <span
            class="dot-live"
            data-state={reachable === null ? 'loading' : reachable ? 'ok' : 'down'}
          />
          <span>
            <span class="label">{reachable === false ? 'offline' : 'online'} · </span>
            {chunksLabel} chunks
          </span>
        </div>
        {showUserMenu && <UserMenu />}
      </div>
    </header>
  );
}