import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { Router } from 'wouter-preact';
import { memoryLocation } from 'wouter-preact/memory-location';
import { UserMenu } from '../../src/components/UserMenu';
import { AuthProvider } from '../../src/hooks/useAuth';
import type { AuthUser } from '../../src/services/auth';

// p4-T17 — UserMenu covers four behaviors:
//
//   1. Renders the username chip when authenticated; renders
//      nothing while loading or anonymous (no flicker).
//   2. Clicking the chip opens the dropdown; clicking outside or
//      pressing Escape closes it.
//   3. Admin sees Admin → Users + Admin → Invites; non-admin does
//      not.
//   4. Logout calls POST /api/auth/logout, refreshes auth state,
//      and navigates to /login.
//
// The test wraps in AuthProvider + a wouter Router so useAuth() and
// useLocation() have working providers. fetch is stubbed so the
// provider's /api/auth/me call resolves the user we want, and so we
// can assert the logout POST fired.

function mockMeAndLogout(user: AuthUser | null) {
  // After /api/auth/logout fires, subsequent /api/auth/me calls
  // should return 401 — the real server clears the session cookie,
  // so the SPA's post-logout refresh() sees an anonymous viewer.
  let loggedOut = false;
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/auth/logout') {
      loggedOut = true;
      return Promise.resolve(
        new Response('', { status: 200, headers: { 'content-type': 'application/json' } })
      );
    }
    if (url === '/api/auth/me') {
      const treatAsAnon = loggedOut || user === null;
      return treatAsAnon
        ? Promise.resolve(new Response('{"error":"Authentication required"}', { status: 401 }))
        : Promise.resolve(
            new Response(JSON.stringify(user), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          );
    }
    void init;
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderMenu(opts: {
  user: AuthUser | null;
  initialPath?: string;
}) {
  const user = opts.user;
  const memLoc = memoryLocation({ path: opts.initialPath ?? '/chat', record: true });
  const fetchMock = mockMeAndLogout(user);
  const result = render(
    <Router hook={memLoc.hook}>
      <AuthProvider>
        <UserMenu />
      </AuthProvider>
    </Router>
  );
  return { ...result, memLoc, fetchMock };
}

async function waitForChip(container: HTMLElement, username: string) {
  await waitFor(() => {
    expect(container.querySelector('.user-menu-chip')?.textContent).toContain(username);
  });
}

describe('UserMenu (p4-T17)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the username chip when authenticated', async () => {
    const { container } = renderMenu({
      user: { id: 'u1', username: 'alice', role: 'user' },
    });
    await waitForChip(container, 'alice');
  });

  it('renders nothing while the user is anonymous (no chip, no flicker)', () => {
    // Initial AuthProvider status is 'loading' until /api/auth/me
    // resolves; with a 401 it flips to 'anonymous' and user stays
    // null, so UserMenu returns null.
    const { container } = renderMenu({ user: null });
    expect(container.querySelector('.user-menu-chip')).toBeNull();
    expect(container.querySelector('.user-menu-pop')).toBeNull();
  });

  it('opens the dropdown on click; closes on outside mousedown', async () => {
    const { container } = renderMenu({
      user: { id: 'u1', username: 'alice', role: 'user' },
    });
    await waitForChip(container, 'alice');

    // Dropdown not visible until clicked.
    expect(container.querySelector('.user-menu-pop')).toBeNull();

    fireEvent.click(container.querySelector('.user-menu-chip')!);
    const pop = container.querySelector('.user-menu-pop');
    expect(pop).not.toBeNull();
    expect(pop!.getAttribute('role')).toBe('menu');
    // Logout always visible for any user.
    expect(pop!.querySelectorAll('.user-menu-logout')).toHaveLength(1);

    // Outside mousedown closes it.
    fireEvent.mouseDown(document.body);
    expect(container.querySelector('.user-menu-pop')).toBeNull();
  });

  it('closes the dropdown on Escape', async () => {
    const { container } = renderMenu({
      user: { id: 'u1', username: 'alice', role: 'user' },
    });
    await waitForChip(container, 'alice');
    fireEvent.click(container.querySelector('.user-menu-chip')!);
    expect(container.querySelector('.user-menu-pop')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.user-menu-pop')).toBeNull();
  });

  it('admin sees both admin links; non-admin sees neither', async () => {
    const admin = renderMenu({
      user: { id: 'a1', username: 'root', role: 'admin' },
    });
    await waitForChip(admin.container, 'root');
    fireEvent.click(admin.container.querySelector('.user-menu-chip')!);
    const adminPop = admin.container.querySelector('.user-menu-pop')!;
    const adminLinks = adminPop.querySelectorAll('a.user-menu-item');
    expect(adminLinks).toHaveLength(2);
    expect(adminLinks[0]!.getAttribute('href')).toBe('/admin/users');
    expect(adminLinks[1]!.getAttribute('href')).toBe('/admin/invites');
    expect(adminLinks[0]!.textContent).toContain('Admin → Users');
    expect(adminLinks[1]!.textContent).toContain('Admin → Invites');
    cleanup();

    const user = renderMenu({
      user: { id: 'u2', username: 'bob', role: 'user' },
    });
    await waitForChip(user.container, 'bob');
    fireEvent.click(user.container.querySelector('.user-menu-chip')!);
    const userPop = user.container.querySelector('.user-menu-pop')!;
    expect(userPop.querySelectorAll('a.user-menu-item')).toHaveLength(0);
    expect(userPop.querySelectorAll('.user-menu-logout')).toHaveLength(1);
  });

  it('logout click POSTs /api/auth/logout, refreshes, and navigates to /login', async () => {
    const { container, memLoc, fetchMock } = renderMenu({
      user: { id: 'u1', username: 'alice', role: 'user' },
      initialPath: '/chat',
    });
    await waitForChip(container, 'alice');

    // After the chip renders, the fetchMock has been called once
    // for /api/auth/me. Subsequent calls include the logout POST.
    const callsBefore = fetchMock.mock.calls.length;
    expect(callsBefore).toBeGreaterThanOrEqual(1);

    fireEvent.click(container.querySelector('.user-menu-chip')!);
    fireEvent.click(container.querySelector('.user-menu-logout')!);

    // Assert the logout endpoint was hit with credentials: 'include'.
    await waitFor(() => {
      const logoutCall = fetchMock.mock.calls.find(
        ([u, init]) => u === '/api/auth/logout' && (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(logoutCall).toBeDefined();
      const init = logoutCall![1] as RequestInit;
      expect(init.credentials).toBe('include');
    });

    // After logout: refresh() re-fetches /api/auth/me (which our
    // mock returns as 401) and we navigate to /login. The auth
    // status flips to anonymous, so the chip unmounts.
    await waitFor(() => {
      expect(container.querySelector('.user-menu-chip')).toBeNull();
    });
    await waitFor(() => {
      expect(memLoc.history.at(-1)).toBe('/login');
    });
  });

  it('logout still navigates to /login even if /api/auth/logout throws', async () => {
    const { container, memLoc, fetchMock } = renderMenu({
      user: { id: 'u1', username: 'alice', role: 'user' },
    });
    await waitForChip(container, 'alice');

    // Make logout return 500. /api/auth/me keeps returning 401, so
    // the post-logout refresh still flips auth to anonymous.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/auth/logout') {
        return Promise.resolve(
          new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } })
        );
      }
      if (url === '/api/auth/me') {
        return Promise.resolve(new Response('{"error":"Authentication required"}', { status: 401 }));
      }
      void init;
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    fireEvent.click(container.querySelector('.user-menu-chip')!);
    fireEvent.click(container.querySelector('.user-menu-logout')!);

    await waitFor(() => {
      expect(memLoc.history.at(-1)).toBe('/login');
    });
  });
});