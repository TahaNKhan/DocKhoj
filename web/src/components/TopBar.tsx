import { Link, useLocation } from 'wouter-preact';
import type { ServerStatus } from '../services/status';

// TopBar — brand mark + burger (mobile) + nav pills + status indicator.
// The status pill is fed by /api/status (polled in App): it shows the
// live chunk count from Qdrant and reflects Ollama reachability. While
// the first poll is in flight we render an em-dash so the layout
// doesn't jump.

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  status: ServerStatus | null;
}

export function TopBar({ sidebarOpen, onToggleSidebar, status }: Props) {
  const [path] = useLocation();
  const isChat = path === '/' || path.startsWith('/chat');
  const isUpload = path.startsWith('/upload');

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
    </header>
  );
}