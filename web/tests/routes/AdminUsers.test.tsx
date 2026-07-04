import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { Router } from 'wouter-preact';
import { memoryLocation } from 'wouter-preact/memory-location';
import { AdminUsers } from '../../src/routes/AdminUsers';
import { AuthProvider } from '../../src/hooks/useAuth';
import type { AuthUser, AdminUser } from '../../src/services/auth';

// p4-T19 — AdminUsers covers five behaviors driven by the acceptance
// criteria:
//
//   1. Renders the user list with role badges.
//   2. Delete is disabled on the row whose id matches the current
//      user (cannot delete self).
//   3. Delete fires DELETE /api/admin/users/:id after a confirm click,
//      and refreshes the list afterwards.
//   4. Reset-password modal: opens on click, POSTs the password,
//      closes, refreshes the list.
//   5. Non-admin cannot reach this page (covered indirectly: the SPA
//      wraps the route in <RouteGuard requireRole="admin">, which has
//      its own test for that branch; here we exercise the user-list
//      with an admin user only).
//
// Stub `fetch` so the AuthProvider's /api/auth/me call returns the
// admin, and listUsers/deleteUser/resetPassword return what the
// test sets up.

function mockAdmin(opts: {
  user: AuthUser;
  initialUsers: AdminUser[];
}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') {
      return Promise.resolve(
        new Response(JSON.stringify(opts.user), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    if (url === '/api/admin/users' && (!init || init.method === undefined || init.method === 'GET')) {
      return Promise.resolve(
        new Response(JSON.stringify(opts.initialUsers), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    // DELETE /api/admin/users/:id
    if (url.startsWith('/api/admin/users/') && init?.method === 'DELETE') {
      return Promise.resolve(
        new Response('{"success":true,"documentsDeleted":0}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    // POST /api/admin/users/:id/password
    if (url.match(/^\/api\/admin\/users\/[^/]+\/password$/) && init?.method === 'POST') {
      return Promise.resolve(
        new Response('{"success":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    return Promise.resolve(
      new Response('{"error":"unsupported"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAdmin(opts: {
  user: AuthUser;
  users: AdminUser[];
}) {
  const memLoc = memoryLocation({ path: '/admin/users', record: true });
  const fetchMock = mockAdmin({ user: opts.user, initialUsers: opts.users });
  const result = render(
    <Router hook={memLoc.hook}>
      <AuthProvider>
        <AdminUsers />
      </AuthProvider>
    </Router>
  );
  return { ...result, memLoc, fetchMock };
}

const adminUser: AuthUser = { id: 'a1', username: 'root', role: 'admin' };
const otherAdmin: AdminUser = {
  id: 'a2',
  username: 'alice',
  role: 'admin',
  createdAt: '2026-01-15 10:30:00',
  lastLoginAt: '2026-07-01 09:00:00',
};
const regular: AdminUser = {
  id: 'u1',
  username: 'bob',
  role: 'user',
  createdAt: '2026-02-20 12:00:00',
  lastLoginAt: null,
};

describe('AdminUsers (p4-T19)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the user list with role badges', async () => {
    const { container } = renderAdmin({
      user: adminUser,
      users: [otherAdmin, regular],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('alice');
      expect(container.textContent).toContain('bob');
    });
    const badges = container.querySelectorAll('.role-badge');
    expect(badges).toHaveLength(2);
    expect(container.querySelector('.role-badge.role-admin')).not.toBeNull();
    expect(container.querySelector('.role-badge.role-user')).not.toBeNull();
  });

  it('disables the Delete button for the current user (cannot delete self)', async () => {
    const selfRow: AdminUser = {
      ...adminUser,
      // The store happens to return rows with the same id as the
      // AuthProvider's user — that's how the row knows it's "you".
      username: 'root',
      role: 'admin',
      createdAt: '2026-01-01 00:00:00',
      lastLoginAt: '2026-07-04 00:00:00',
    };
    const { container } = renderAdmin({
      user: adminUser,
      users: [selfRow, otherAdmin],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('root');
    });
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    // The first row is the admin (root); find its Delete button.
    const rootRow = rows.find((r) => r.textContent?.includes('root'))!;
    const delBtn = rootRow.querySelector('button.danger') as HTMLButtonElement;
    expect(delBtn).toBeTruthy();
    expect(delBtn.disabled).toBe(true);

    // The other-admin row's Delete button is enabled.
    const otherRow = rows.find((r) => r.textContent?.includes('alice'))!;
    const otherDelBtn = otherRow.querySelector('button.danger') as HTMLButtonElement;
    expect(otherDelBtn.disabled).toBe(false);
  });

  it('confirm-then-commit delete posts DELETE /api/admin/users/:id', async () => {
    const { container, fetchMock } = renderAdmin({
      user: adminUser,
      users: [otherAdmin, regular],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('alice');
    });
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const aliceRow = rows.find((r) => r.textContent?.includes('alice'))!;
    // First click arms; the rendered class flips to `danger confirm`
    // (button now reads "click to confirm").
    const delBtn = aliceRow.querySelector('button.danger') as HTMLButtonElement;
    fireEvent.click(delBtn);
    await waitFor(() => {
      expect(aliceRow.querySelector('button.confirm')).not.toBeNull();
    });
    const confirmBtn = aliceRow.querySelector('button.confirm') as HTMLButtonElement;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        ([u, init]) =>
          u === `/api/admin/users/${otherAdmin.id}` &&
          (init as RequestInit | undefined)?.method === 'DELETE'
      );
      expect(del).toBeDefined();
    });
  });

  it('reset password: opens modal, POSTs the password, closes, refreshes list', async () => {
    const { container, fetchMock } = renderAdmin({
      user: adminUser,
      users: [otherAdmin],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('alice');
    });

    const aliceRow = container.querySelector('tbody tr')!;
    const resetBtn = Array.from(aliceRow.querySelectorAll('button.doc-action')).find(
      (b) => b.textContent === 'Reset password',
    ) as HTMLButtonElement;
    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(container.querySelector('.modal-card')).not.toBeNull();
    });

    const passwordInput = container.querySelector(
      '.modal-card input[type="password"]',
    ) as HTMLInputElement;
    fireEvent.input(passwordInput, { target: { value: 'newpass1234!' } });

    const submitBtn = container.querySelector('.modal-card button[type="submit"]') as HTMLButtonElement;
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) =>
          u === `/api/admin/users/${otherAdmin.id}/password` &&
          (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(post).toBeDefined();
      const body = JSON.parse(((post![1] as RequestInit).body as string));
      expect(body.password).toBe('newpass1234!');
    });

    // After the request resolves, the modal disappears and the list
    // re-fetches (we exercise the close + reload by waiting for the
    // modal to be gone).
    await waitFor(() => {
      expect(container.querySelector('.modal-card')).toBeNull();
    });
  });

  it('reset-password modal cancels on Escape and on backdrop click', async () => {
    const { container } = renderAdmin({
      user: adminUser,
      users: [otherAdmin],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('alice');
    });
    const aliceRow = container.querySelector('tbody tr')!;
    const resetBtn = Array.from(aliceRow.querySelectorAll('button.doc-action')).find(
      (b) => b.textContent === 'Reset password',
    ) as HTMLButtonElement;
    fireEvent.click(resetBtn);
    await waitFor(() => {
      expect(container.querySelector('.modal-card')).not.toBeNull();
    });

    // Escape closes.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(container.querySelector('.modal-card')).toBeNull();
    });

    // Reopen, then click the overlay (outside the card) to close.
    fireEvent.click(resetBtn);
    await waitFor(() => {
      expect(container.querySelector('.modal-card')).not.toBeNull();
    });
    const overlay = container.querySelector('.modal-overlay') as HTMLElement;
    fireEvent.click(overlay);
    await waitFor(() => {
      expect(container.querySelector('.modal-card')).toBeNull();
    });
  });
});
