import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TopBar } from '../../src/components/TopBar';
import * as themeModule from '../../src/services/theme';
import type { ServerStatus } from '../../src/services/status';

// TopBar depends on useLocation and useAuth. Mock both at the module
// level so every test gets a clean default. Tests that need a specific
// path override useLocation's return value via mockReturnValue.
const mockSetLocation = vi.fn();
const mockUseLocation = vi.fn(() => ['/chat', mockSetLocation]);
vi.mock('wouter-preact', () => ({
  useLocation: () => mockUseLocation(),
  Link: ({ href, class: cls, children }: Record<string, any>) =>
    <a href={href} class={cls}>{children}</a>,
}));
vi.mock('../../src/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({ user: null, status: 'anonymous', refresh: vi.fn() })),
}));

function makeStatus(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    chunks: 298,
    ollamaAvailable: true,
    llmModel: 'gpt-4o',
    llmContextSize: 128_000,
    ...overrides,
  };
}

function renderTopBar(opts: {
  initialPath?: string;
  status?: ServerStatus | null;
}) {
  mockUseLocation.mockReturnValue([opts.initialPath ?? '/chat', mockSetLocation]);

  return render(
    <TopBar
      sidebarOpen={false}
      onToggleSidebar={() => {}}
      status={opts.status ?? makeStatus()}
    />
  );
}

describe('TopBar — theme toggle', () => {
  beforeEach(() => {
    // happy-dom reports OS prefers light by default. Set a
    // deterministic starting state (dark) so tests are portable.
    localStorage.setItem('dockhoj:theme', 'dark');
    document.documentElement.dataset.theme = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a theme toggle button with a sun icon (dark mode)', () => {
    const { container } = renderTopBar({});
    const btn = container.querySelector('.theme-toggle');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('\u2600');
  });

  it('has the correct aria-label in dark mode', () => {
    const { container } = renderTopBar({});
    const btn = container.querySelector('.theme-toggle')!;
    expect(btn.getAttribute('aria-label')).toBe('Switch to light mode');
  });

  it('has the correct aria-label in light mode', () => {
    localStorage.setItem('dockhoj:theme', 'light');
    const { container } = renderTopBar({});
    const btn = container.querySelector('.theme-toggle')!;
    expect(btn.getAttribute('aria-label')).toBe('Switch to dark mode');
  });

  it('shows moon icon in light mode', () => {
    localStorage.setItem('dockhoj:theme', 'light');
    const { container } = renderTopBar({});
    const btn = container.querySelector('.theme-toggle')!;
    expect(btn.textContent).toBe('\u263E');
  });

  it('clicking the toggle switches theme from dark to light', () => {
    localStorage.setItem('dockhoj:theme', 'dark');
    const setThemeSpy = vi.spyOn(themeModule, 'setTheme');
    const { container } = renderTopBar({});
    const btn = container.querySelector('.theme-toggle')!;

    // Initially dark → sun icon, "Switch to light".
    expect(btn.textContent).toBe('\u2600');

    fireEvent.click(btn);

    expect(setThemeSpy).toHaveBeenCalledWith('light');
    expect(localStorage.getItem('dockhoj:theme')).toBe('light');
    expect(btn.textContent).toBe('\u263E');
    expect(btn.getAttribute('aria-label')).toBe('Switch to dark mode');
    setThemeSpy.mockRestore();
  });

  it('clicking the toggle switches theme from light to dark', () => {
    localStorage.setItem('dockhoj:theme', 'light');
    const setThemeSpy = vi.spyOn(themeModule, 'setTheme');
    const { container } = renderTopBar({});
    const btn = container.querySelector('.theme-toggle')!;

    // Initially light → moon icon, "Switch to dark".
    expect(btn.textContent).toBe('\u263E');

    fireEvent.click(btn);

    expect(setThemeSpy).toHaveBeenCalledWith('dark');
    expect(localStorage.getItem('dockhoj:theme')).toBe('dark');
    expect(btn.textContent).toBe('\u2600');
    expect(btn.getAttribute('aria-label')).toBe('Switch to light mode');
    setThemeSpy.mockRestore();
  });
});

describe('TopBar — nav pills and status', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders both nav links (Chat and Upload)', () => {
    const { container } = renderTopBar({});
    const links = container.querySelectorAll('.topnav a');
    expect(links).toHaveLength(2);
    expect(links[0]!.textContent).toBe('Chat');
    expect(links[1]!.textContent).toBe('Upload');
  });

  it('marks the Chat link as active on /chat', () => {
    const { container } = renderTopBar({ initialPath: '/chat' });
    const [chat, upload] = container.querySelectorAll('.topnav a');
    expect(chat!.classList.contains('active')).toBe(true);
    expect(upload!.classList.contains('active')).toBe(false);
  });

  it('marks the Upload link as active on /upload', () => {
    const { container } = renderTopBar({ initialPath: '/upload' });
    const [chat, upload] = container.querySelectorAll('.topnav a');
    expect(upload!.classList.contains('active')).toBe(true);
    expect(chat!.classList.contains('active')).toBe(false);
  });

  it('shows the status pill with online and chunk count', () => {
    const { container } = renderTopBar({ status: makeStatus({ chunks: 500, ollamaAvailable: true }) });
    const topmeta = container.querySelector('.topmeta');
    expect(topmeta?.textContent).toContain('online');
    expect(topmeta?.textContent).toContain('500');
  });

  it('shows offline when ollama is unreachable', () => {
    const { container } = renderTopBar({ status: makeStatus({ ollamaAvailable: false }) });
    const topmeta = container.querySelector('.topmeta');
    expect(topmeta?.textContent).toContain('offline');
  });

  it('shows em-dash while chunk count is undefined', () => {
    const { container } = renderTopBar({ status: makeStatus({ chunks: undefined }) });
    const topmeta = container.querySelector('.topmeta');
    expect(topmeta?.textContent).toContain('\u2014');
  });

  it('renders the burger button with correct aria attributes', () => {
    const { container } = renderTopBar({});
    const burger = container.querySelector('.burger');
    expect(burger).not.toBeNull();
    expect(burger!.getAttribute('aria-label')).toBe('Open sessions');
    expect(burger!.getAttribute('aria-expanded')).toBe('false');
    expect(burger!.getAttribute('aria-controls')).toBe('sidebar');
  });
});
