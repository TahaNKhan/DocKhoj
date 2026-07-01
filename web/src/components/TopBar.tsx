import { Link, useLocation } from 'wouter-preact';

// TopBar — brand mark + burger (mobile) + nav pills + status indicator.
// The status pill is currently a fixed string ("online · 2,847 chunks");
// T34+T35 wire it to /api/status for live chunk count and Ollama
// reachability.

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function TopBar({ sidebarOpen, onToggleSidebar }: Props) {
  const [path] = useLocation();
  const isChat = path === '/' || path.startsWith('/chat');
  const isUpload = path.startsWith('/upload');

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

      <div class="topmeta">
        <span class="dot-live" />
        <span>
          <span class="label">online · </span>
          2,847 chunks
        </span>
      </div>
    </header>
  );
}