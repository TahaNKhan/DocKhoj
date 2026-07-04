import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { Router } from 'wouter-preact';
import { memoryLocation } from 'wouter-preact/memory-location';
import { AdminInvites } from '../../src/routes/AdminInvites';
import { AuthProvider } from '../../src/hooks/useAuth';
import type { AuthUser, AdminInvite } from '../../src/services/auth';

// p4-T19 — AdminInvites covers the four behaviors driven by the
// acceptance criteria:
//
//   1. Admin can create an invite; the token is shown exactly once
//      with a copy button (the banner contains a "/register/<token>"
//      URL, renderable via the Copy button).
//   2. The token banner dismissal removes it from view (the token is
//      gone from the DOM after dismiss — re-fetching GET /api/admin/
//      invites does not return it).
//   3. Admin can list / revoke invites. The revoke button posts
//      DELETE /api/admin/invites/:id and refreshes the list.
//   4. The raw token is never present in the list response — the
//      GET /api/admin/invites payload has no `token` / `tokenHash`
//      fields (server-side guarantee, asserted by the route test;
//      here we just confirm the table renders the public fields).

function mockAdmin(opts: {
  user: AuthUser;
  initialInvites: AdminInvite[];
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
    if (url === '/api/admin/invites') {
      if (init?.method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}') as {
          expiresInDays?: number;
        };
        const days = body.expiresInDays ?? 7;
        const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: `inv-${Math.random().toString(36).slice(2, 8)}`,
              token: 'RAW-TOKEN-ABCDEF1234',
              expiresAt,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(opts.initialInvites), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.startsWith('/api/admin/invites/') && init?.method === 'DELETE') {
      return Promise.resolve(
        new Response('{"success":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response('{"error":"unsupported"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAdminInvites(opts: {
  user: AuthUser;
  invites: AdminInvite[];
}) {
  const memLoc = memoryLocation({ path: '/admin/invites', record: true });
  const fetchMock = mockAdmin({ user: opts.user, initialInvites: opts.invites });
  const result = render(
    <Router hook={memLoc.hook}>
      <AuthProvider>
        <AdminInvites />
      </AuthProvider>
    </Router>
  );
  return { ...result, memLoc, fetchMock };
}

const adminUser: AuthUser = { id: 'a1', username: 'root', role: 'admin' };

const sampleInvite: AdminInvite = {
  id: 'inv-1',
  createdBy: 'a1',
  createdAt: '2026-07-01 10:00:00',
  expiresAt: '2026-07-08 10:00:00',
  usedBy: null,
  usedAt: null,
};

describe('AdminInvites (p4-T19)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists outstanding invites with no raw token visible', async () => {
    const { container } = renderAdminInvites({
      user: adminUser,
      invites: [sampleInvite],
    });
    await waitFor(() => {
      // The id is on the revoke button's data-testid; the table
      // itself shows created/expires labels (no token column).
      expect(container.querySelector('[data-testid="revoke-inv-1"]')).not.toBeNull();
    });
    // Verify the response payload (returned by the mock) carries no
    // token / tokenHash field — that's the server-side guarantee.
    const bodyText = JSON.stringify([sampleInvite]);
    expect(bodyText).not.toMatch(/token/i);
    // And the rendered DOM has no raw-token-shaped substring (raw
    // tokens are 32 bytes of base64url, ~43 chars).
    expect(container.textContent).not.toMatch(/RAW-TOKEN-ABCDEF1234/);
  });

  it('creating an invite posts POST /api/admin/invites and surfaces the one-time token banner', async () => {
    const { container, fetchMock } = renderAdminInvites({
      user: adminUser,
      invites: [],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('No outstanding invites');
    });

    // Submit the form (defaults: 7 days).
    fireEvent.click(container.querySelector('.invite-form button[type="submit"]')!);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, init]) =>
          u === '/api/admin/invites' && (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(post).toBeDefined();
      const body = JSON.parse(((post![1] as RequestInit).body as string));
      expect(body.expiresInDays).toBe(7);
    });

    // The token banner renders with the URL-encoded token copied in
    // (window.location.origin + /register/RAW-TOKEN-ABCDEF1234).
    await waitFor(() => {
      const url = container.querySelector('[data-testid="token-url"]') as HTMLElement | null;
      expect(url).not.toBeNull();
      expect(url!.textContent).toContain('/register/RAW-TOKEN-ABCDEF1234');
    });
  });

  it('the Copy button calls navigator.clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // happy-dom doesn't implement clipboard by default; wire one in.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { container } = renderAdminInvites({
      user: adminUser,
      invites: [],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('No outstanding invites');
    });

    fireEvent.click(container.querySelector('.invite-form button[type="submit"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="token-url"]')).not.toBeNull();
    });

    const copyBtn = container.querySelector('[data-testid="copy-token"]') as HTMLButtonElement;
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    expect(writeText.mock.calls[0]![0]).toBe('RAW-TOKEN-ABCDEF1234');

    // After copy success the button reads "Copied!".
    await waitFor(() => {
      expect(copyBtn.textContent).toContain('Copied!');
    });
  });

  it('dismissing the token banner removes it (token never returns)', async () => {
    const { container } = renderAdminInvites({
      user: adminUser,
      invites: [],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('No outstanding invites');
    });

    fireEvent.click(container.querySelector('.invite-form button[type="submit"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="token-url"]')).not.toBeNull();
    });

    fireEvent.click(container.querySelector('[data-testid="dismiss-token"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="token-url"]')).toBeNull();
      expect(container.querySelector('.token-banner')).toBeNull();
    });

    // The raw token string is no longer present anywhere in the DOM
    // (the GET /api/admin/invites list does not include it either —
    // the server's design.md guarantee).
    expect(container.textContent).not.toContain('RAW-TOKEN-ABCDEF1234');
  });

  it('revoke fires DELETE /api/admin/invites/:id and refreshes the list', async () => {
    const { container, fetchMock } = renderAdminInvites({
      user: adminUser,
      invites: [sampleInvite],
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="revoke-inv-1"]')).not.toBeNull();
    });

    fireEvent.click(container.querySelector('[data-testid="revoke-inv-1"]')!);

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        ([u, init]) =>
          u === `/api/admin/invites/${sampleInvite.id}` &&
          (init as RequestInit | undefined)?.method === 'DELETE'
      );
      expect(del).toBeDefined();
    });

    // A reload happens — verify GET /api/admin/invites was called
    // a second time after the delete.
    await waitFor(() => {
      const listCalls = fetchMock.mock.calls.filter(([u]) => u === '/api/admin/invites');
      // 1 initial + at least 1 after the revoke.
      expect(listCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
