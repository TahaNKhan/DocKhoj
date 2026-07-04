import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/preact';
import { Chrome } from '../../src/App';

// Chrome depends on useLocation (wouter), useAuth, and several
// services. Mock them at module level so every test gets clean
// defaults; individual tests override mockReturnValue as needed.
const mockSetLocation = vi.fn();
const mockUseLocation = vi.fn(() => ['/chat', mockSetLocation]);
vi.mock('wouter-preact', () => ({
  useLocation: () => mockUseLocation(),
  useRoute: vi.fn(() => [null, {} as Record<string, string | undefined>]),
  Link: ({ href, class: cls, children }: Record<string, any>) =>
    <a href={href} class={cls}>{children}</a>,
  Redirect: ({ to }: { to: string }) => {
    return <div data-testid="redirect" data-to={to} />;
  },
  Route: ({ path, children }: { path: string; children: any }) =>
    <div data-route={path}>{children}</div>,
  Switch: ({ children }: any) => <div data-testid="switch">{children}</div>,
}));
vi.mock('../../src/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({ user: null, status: 'anonymous', refresh: vi.fn() })),
}));

// Mock session service — track calls to prove they fire or not.
const mockListSessions = vi.fn();
const mockLoadActiveSessionId = vi.fn();
const mockSaveActiveSessionId = vi.fn();
const mockCreateSession = vi.fn();
const mockListMessages = vi.fn();
vi.mock('../../src/services/sessions', () => ({
  listSessions: (...args: any[]) => mockListSessions(...args),
  loadActiveSessionId: (...args: any[]) => mockLoadActiveSessionId(...args),
  saveActiveSessionId: (...args: any[]) => mockSaveActiveSessionId(...args),
  createSession: (...args: any[]) => mockCreateSession(...args),
  listMessages: (...args: any[]) => mockListMessages(...args),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  getPinnedIds: vi.fn(() => []),
  togglePinnedId: vi.fn(() => false),
}));

vi.mock('../../src/services/status', () => ({
  fetchStatus: vi.fn(() => Promise.resolve({ chunks: 298, ollamaAvailable: true })),
}));

vi.mock('../../src/services/auth', () => ({
  fetchAuthStatus: vi.fn(() => Promise.resolve({ firstUserAvailable: false })),
}));

describe('Chrome — sessions load on upload route', () => {
  beforeEach(() => {
    mockListSessions.mockResolvedValue([
      { id: 's1', title: 'Session 1', titleSource: 'default', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00', messageCount: 3 },
      { id: 's2', title: 'Session 2', titleSource: 'default', createdAt: '2026-01-02 00:00:00', updatedAt: '2026-01-02 00:00:00', messageCount: 1 },
    ]);
    mockLoadActiveSessionId.mockReturnValue('s1');
    mockListMessages.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('calls listSessions on the chat route', async () => {
    mockUseLocation.mockReturnValue(['/chat', mockSetLocation]);
    render(<Chrome />);
    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });

  it('calls listSessions on the upload route', async () => {
    mockUseLocation.mockReturnValue(['/upload', mockSetLocation]);
    render(<Chrome />);
    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    expect(mockListSessions).toHaveBeenCalledTimes(1);
  });

  it('does NOT call listSessions on the login route', async () => {
    mockUseLocation.mockReturnValue(['/login', mockSetLocation]);
    render(<Chrome />);
    // Allow some time for an accidental call to resolve.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it('loads the active session and messages on the chat route', async () => {
    mockUseLocation.mockReturnValue(['/chat', mockSetLocation]);
    render(<Chrome />);
    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    await waitFor(() => expect(mockLoadActiveSessionId).toHaveBeenCalled());
    await waitFor(() => expect(mockListMessages).toHaveBeenCalledWith('s1'));
  });

  it('does NOT load active session or messages on the upload route', async () => {
    mockUseLocation.mockReturnValue(['/upload', mockSetLocation]);
    render(<Chrome />);
    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    // Give a moment — these must NOT fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockLoadActiveSessionId).not.toHaveBeenCalled();
    expect(mockListMessages).not.toHaveBeenCalled();
  });
});
