import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/preact';
import { Router } from 'wouter-preact';
import { memoryLocation } from 'wouter-preact/memory-location';
import { RouteGuard } from '../../src/components/RouteGuard';
import { AuthProvider } from '../../src/hooks/useAuth';
import type { AuthUser } from '../../src/services/auth';

// p4-T16 — RouteGuard wires the SPA's auth state to its render.
// Three observable behaviours:
//   1. anonymous → redirect to /login?next=<original-path>
//   2. authenticated → render children
//   3. authenticated + requireRole='admin' + non-admin user → 403 view
//
// We stub `fetch` so the AuthProvider's mount-time /api/auth/me call
// resolves the scenario we're testing. A memoryLocation hook stands
// in for the browser history so the redirect can be observed
// without touching the real URL.

function mockMe(user: AuthUser | null) {
  const fetchMock = vi.fn().mockResolvedValue(
    user === null
      ? new Response('{"error":"Authentication required"}', { status: 401 })
      : new Response(JSON.stringify(user), { status: 200, headers: { 'content-type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderGuard(opts: {
  user: AuthUser | null;
  initialPath?: string;
  requireRole?: 'admin';
  children?: preact.ComponentChildren;
}) {
  const user = opts.user;
  const memLoc = memoryLocation({ path: opts.initialPath ?? '/chat', record: true });
  mockMe(user);
  const result = render(
    <Router hook={memLoc.hook}>
      <AuthProvider>
        <RouteGuard requireRole={opts.requireRole}>
          {opts.children ?? <div class="protected-content">protected</div>}
        </RouteGuard>
      </AuthProvider>
    </Router>
  );
  return { ...result, memLoc };
}

describe('RouteGuard (p4-T16)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('redirects anonymous users to /login?next=<original-path>', async () => {
    const { memLoc, container } = renderGuard({
      user: null,
      initialPath: '/chat',
    });

    // The fetch resolves with 401 → status flips to 'anonymous' →
    // useEffect navigates. Wait for the redirect to fire.
    await waitFor(() => {
      expect(memLoc.history.at(-1)).toBe('/login?next=%2Fchat');
    });

    // Children are not rendered.
    expect(container.querySelector('.protected-content')).toBeNull();
  });

  it('preserves the original path (with sub-routes) in the ?next= param', async () => {
    const { memLoc } = renderGuard({
      user: null,
      initialPath: '/upload',
    });
    await waitFor(() => {
      expect(memLoc.history.at(-1)).toBe('/login?next=%2Fupload');
    });
  });

  it('renders children when authenticated', async () => {
    const { container } = renderGuard({
      user: { id: 'u1', username: 'alice', role: 'user' },
      initialPath: '/chat',
    });
    // Wait for the AuthProvider to flip to 'authenticated'.
    await waitFor(() => {
      expect(container.querySelector('.protected-content')?.textContent).toBe('protected');
    });
  });

  it('renders a 403 view for a non-admin user when requireRole="admin"', async () => {
    const { container } = renderGuard({
      user: { id: 'u2', username: 'bob', role: 'user' },
      initialPath: '/admin/users',
      requireRole: 'admin',
    });
    await waitFor(() => {
      const denied = container.querySelector('.route-denied');
      expect(denied).not.toBeNull();
      expect(denied!.textContent).toContain('403');
    });
    expect(container.querySelector('.protected-content')).toBeNull();
  });

  it('renders children for an admin user when requireRole="admin"', async () => {
    const { container } = renderGuard({
      user: { id: 'a1', username: 'root', role: 'admin' },
      initialPath: '/admin/users',
      requireRole: 'admin',
    });
    await waitFor(() => {
      expect(container.querySelector('.protected-content')?.textContent).toBe('protected');
    });
    expect(container.querySelector('.route-denied')).toBeNull();
  });
});