import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { Sidebar } from '../../src/components/Sidebar';
import { getPinnedIds, togglePinnedId } from '../../src/services/sessions';
import type { Conversation } from '../../src/services/sessions';

// Small follow-up (post-p3): every session row gets an explicit ×
// delete button so the destructive action is discoverable on
// touch devices and on desktop without right-click.

function makeSession(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'sess-1',
    title: 'My chat',
    titleSource: 'default',
    createdAt: '2026-07-01 09:00:00',
    updatedAt: '2026-07-01 10:00:00',
    messageCount: 3,
    ...overrides,
  };
}

describe('Sidebar — per-row delete button', () => {
  let confirmMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // happy-dom doesn't ship window.confirm by default; stub it so
    // the SessionRow's onClick / onContextMenu can be tested.
    confirmMock = vi.fn();
    vi.stubGlobal('confirm', confirmMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a × button on each session row when onDelete is provided', () => {
    const { container } = render(
      <Sidebar
        sessions={[makeSession({ id: 'a', title: 'first' }), makeSession({ id: 'b', title: 'second' })]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
      />
    );
    const buttons = container.querySelectorAll('.session .x-del');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Delete session first');
    expect(buttons[1]!.getAttribute('aria-label')).toBe('Delete session second');
  });

  it('does not render a × button when onDelete is omitted', () => {
    const { container } = render(
      <Sidebar
        sessions={[makeSession()]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
      />
    );
    expect(container.querySelector('.session .x-del')).toBeNull();
  });

  it('clicking × and confirming calls onDelete with the session id (no select)', async () => {
    confirmMock.mockReturnValue(true);
    const onDelete = vi.fn();
    const onSelect = vi.fn();

    const { container } = render(
      <Sidebar
        sessions={[makeSession({ id: 'target', title: 'kill me' })]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={onSelect}
        onCreate={() => {}}
        onDelete={onDelete}
      />
    );
    fireEvent.click(container.querySelector('.x-del')!);

    expect(confirmMock).toHaveBeenCalledWith('Delete "kill me" and its messages?');
    expect(onDelete).toHaveBeenCalledWith('target');
    // The × click must NOT also trigger row selection.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clicking × and dismissing the confirm dialog does NOT call onDelete', () => {
    confirmMock.mockReturnValue(false);
    const onDelete = vi.fn();

    const { container } = render(
      <Sidebar
        sessions={[makeSession()]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={onDelete}
      />
    );
    fireEvent.click(container.querySelector('.x-del')!);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('right-click still deletes (backwards compatibility for desktop power-users)', () => {
    confirmMock.mockReturnValue(true);
    const onDelete = vi.fn();

    const { container } = render(
      <Sidebar
        sessions={[makeSession({ id: 'ctx-target' })]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={onDelete}
      />
    );
    fireEvent.contextMenu(container.querySelector('.session')!);
    expect(onDelete).toHaveBeenCalledWith('ctx-target');
  });

  it('clicking the row body (not the ×) still triggers onSelect', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sidebar
        sessions={[makeSession({ id: 'pick-me' })]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={onSelect}
        onCreate={() => {}}
        onDelete={() => {}}
      />
    );
    fireEvent.click(container.querySelector('.session .t')!);
    expect(onSelect).toHaveBeenCalledWith('pick-me');
  });
});

describe('Sidebar — pin button', () => {
  beforeEach(() => {
    // Clean localStorage before each test so pin state is isolated.
    localStorage.removeItem('dockhoj.pinned');
  });
  afterEach(() => {
    cleanup();
  });

  it('renders a .pin-btn on each session row', () => {
    const { container } = render(
      <Sidebar
        sessions={[makeSession({ id: 'a' }), makeSession({ id: 'b' })]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
      />
    );
    expect(container.querySelectorAll('.session .pin-btn')).toHaveLength(2);
  });

  it('clicking pin toggles the pinned class and persists to localStorage', async () => {
    const { container } = render(
      <Sidebar
        sessions={[makeSession({ id: 'pin-me' })]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
      />
    );

    fireEvent.click(container.querySelector('.pin-btn')!);
    await waitFor(() => {
      expect(container.querySelector('.pin-btn')!.classList.contains('pinned')).toBe(true);
    });
    expect(getPinnedIds()).toContain('pin-me');

    fireEvent.click(container.querySelector('.pin-btn')!);
    await waitFor(() => {
      expect(container.querySelector('.pin-btn')!.classList.contains('pinned')).toBe(false);
    });
    expect(getPinnedIds()).not.toContain('pin-me');
  });

  it('pinned session appears in the Pinned section, not Sessions', () => {
    togglePinnedId('pin-a');
    const { container } = render(
      <Sidebar
        sessions={[makeSession({ id: 'pin-a', title: 'pinned one' }), makeSession({ id: 'unpin-b', title: 'normal' })]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
      />
    );
    // The pinned section heading exists with the pinned session.
    const headings = container.querySelectorAll('h4');
    const pinnedHeading = Array.from(headings).find((h) => h.textContent === 'Pinned');
    expect(pinnedHeading).toBeTruthy();

    // The pinned session title is rendered.
    const titles = container.querySelectorAll('.session .t');
    const pinnedTitle = Array.from(titles).find((t) => t.textContent === 'pinned one');
    expect(pinnedTitle).toBeTruthy();

    // The unpinned session is still visible.
    const normalTitle = Array.from(titles).find((t) => t.textContent === 'normal');
    expect(normalTitle).toBeTruthy();
  });

  it('clicking pin does NOT trigger onSelect', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sidebar
        sessions={[makeSession({ id: 'no-select' })]}
        activeId={null}
        open={false}
        onClose={() => {}}
        onSelect={onSelect}
        onCreate={() => {}}
        onDelete={() => {}}
      />
    );
    fireEvent.click(container.querySelector('.pin-btn')!);
    expect(onSelect).not.toHaveBeenCalled();
  });
});