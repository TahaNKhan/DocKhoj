import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/preact';
import { Login } from '../../src/routes/Login';
import * as authService from '../../src/services/auth';
import * as useAuthHook from '../../src/hooks/useAuth';

// p6-T09 — Login.tsx SSO button + ?oidc_error mapping. Asserts the
// SPA reads the additive `oidc` field from /status and conditionally
// renders the "Sign in with <Provider>" button, plus the error-message
// map for each `?oidc_error=<code>` query value (FR-20).
//
// Mirrors App.test.tsx's pattern: mock useLocation at module level so
// we can drive the URL the component sees without touching real history.

let mockLocation = '/login';
vi.mock('wouter-preact', () => ({
  useLocation: () => [mockLocation, vi.fn()],
  Link: ({ href, class: cls, children }: Record<string, unknown>) => (
    <a href={href as string} class={cls as string}>
      {children as never}
    </a>
  ),
}));

const mockFetchAuthStatus = vi.spyOn(authService, 'fetchAuthStatus');
const mockUseAuth = vi.spyOn(useAuthHook, 'useAuth');

beforeEach(() => {
  mockUseAuth.mockReturnValue({
    user: null,
    status: 'anonymous',
    refresh: vi.fn(),
  } as never);
  mockLocation = '/login';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Login — SSO button (p6-T09)', () => {
  it('renders the SSO button with the provider name when oidc.enabled=true', async () => {
    mockFetchAuthStatus.mockResolvedValue({
      firstUserAvailable: false,
      oidc: { enabled: true, providerName: 'Authelia' },
    });
    render(<Login />);
    const btn = await screen.findByRole('link', { name: /Sign in with Authelia/ });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('href')).toBe('/api/auth/oidc/login?next=%2Fchat');
  });

  it('passes the ?next query through to the SSO link', async () => {
    mockFetchAuthStatus.mockResolvedValue({
      firstUserAvailable: false,
      oidc: { enabled: true, providerName: 'Authelia' },
    });
    mockLocation = '/login?next=%2Fupload';
    render(<Login />);
    const btn = await screen.findByRole('link', { name: /Sign in with Authelia/ });
    expect(btn.getAttribute('href')).toBe('/api/auth/oidc/login?next=%2Fupload');
  });

  it('hides the SSO button when oidc.enabled=false', async () => {
    mockFetchAuthStatus.mockResolvedValue({
      firstUserAvailable: false,
      oidc: { enabled: false, providerName: '' },
    });
    render(<Login />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('link', { name: /Sign in with/ })).toBeNull();
  });

  it('hides the SSO button when the server returns no `oidc` field (older server)', async () => {
    mockFetchAuthStatus.mockResolvedValue({ firstUserAvailable: false });
    render(<Login />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('link', { name: /Sign in with/ })).toBeNull();
  });

  it('falls back to "SSO" when providerName is blank', async () => {
    mockFetchAuthStatus.mockResolvedValue({
      firstUserAvailable: false,
      oidc: { enabled: true, providerName: '' },
    });
    render(<Login />);
    const btn = await screen.findByRole('link', { name: /Sign in with SSO/ });
    expect(btn).toBeTruthy();
  });
});

describe('Login — ?oidc_error render (FR-20)', () => {
  it.each([
    ['state', /session expired/i],
    ['exchange', /reach the identity provider/i],
    ['token', /sign-in failed/i],
    ['denied', /not permitted/i],
    ['config', /misconfigured/i],
  ])('renders a friendly message for ?oidc_error=%s', async (code, pattern) => {
    mockFetchAuthStatus.mockResolvedValue({ firstUserAvailable: false });
    mockLocation = `/login?oidc_error=${code}`;
    render(<Login />);
    const msg = await screen.findByText(pattern);
    expect(msg).toBeTruthy();
  });

  it('renders a generic fallback message for an unknown oidc_error code', async () => {
    mockFetchAuthStatus.mockResolvedValue({ firstUserAvailable: false });
    mockLocation = '/login?oidc_error=unknown_code';
    render(<Login />);
    const msg = await screen.findByText(/Sign-in failed/);
    expect(msg).toBeTruthy();
  });
});
