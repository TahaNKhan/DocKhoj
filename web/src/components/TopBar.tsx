import { Link, useLocation } from 'wouter-preact';

// TopBar — brand mark + nav pills + status indicator. The status pill
// is currently a fixed string ("online · 2,847 chunks"); T34+T35 wire
// it to /api/status for live chunk count and Ollama reachability.

export function TopBar() {
  const [path] = useLocation();
  const isChat = path === '/' || path.startsWith('/chat');
  const isUpload = path.startsWith('/upload');

  return (
    <header class="topbar">
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
