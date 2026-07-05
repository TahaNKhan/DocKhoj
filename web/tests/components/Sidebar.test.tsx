import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { Sidebar } from '../../src/components/Sidebar';
import { getPinnedIds, togglePinnedId } from '../../src/services/sessions';
import type { Conversation } from '../../src/services/sessions';

// Per-row delete-button + inline confirm: replaces window.confirm()
// (some browsers block it). × and right-click arm the row in place;
// Esc / mousedown-outside / row-body click dismiss; Enter / Delete
// confirms.

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

function renderSidebar(
  props: Partial<Parameters<typeof Sidebar>[0]> & { sessions?: Conversation[] } = {}
) {
  const sessions = props.sessions ?? [makeSession()];
  return render(
    <Sidebar
      sessions={sessions}
      activeId={props.activeId ?? null}
      open={props.open ?? false}
      onClose={props.onClose ?? (() => {})}
      onSelect={props.onSelect ?? (() => {})}
      onCreate={props.onCreate ?? (() => {})}
      onDelete={props.onDelete}
      onRename={props.onRename}
    />
  );
}

describe('Sidebar — per-row delete button', () => {
  afterEach(() => cleanup());

  it('renders a × button on each session row when onDelete is provided', () => {
    const { container } = renderSidebar({
      sessions: [makeSession({ id: 'a', title: 'first' }), makeSession({ id: 'b', title: 'second' })],
      onDelete: () => {},
    });
    const buttons = container.querySelectorAll('.session .x-del');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Delete session first');
    expect(buttons[1]!.getAttribute('aria-label')).toBe('Delete session second');
  });

  it('does not render a × button when onDelete is omitted', () => {
    const { container } = renderSidebar();
    expect(container.querySelector('.session .x-del')).toBeNull();
  });

  it('clicking × swaps it for [Cancel][Delete] (no immediate onDelete, no select)', () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderSidebar({
      sessions: [makeSession({ id: 'target', title: 'kill me' })],
      onDelete,
      onSelect,
    });

    fireEvent.click(container.querySelector('.x-del')!);

    expect(container.querySelector('.x-del')).toBeNull();
    expect(container.querySelector('.del-confirm')).toBeTruthy();
    expect(container.querySelector('.del-no')!.textContent).toBe('Cancel');
    expect(container.querySelector('.del-yes')!.textContent).toBe('Delete');
    expect(onDelete).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Delete button calls onDelete with the session id', () => {
    const onDelete = vi.fn();
    const { container } = renderSidebar({
      sessions: [makeSession({ id: 'target' })],
      onDelete,
    });

    fireEvent.click(container.querySelector('.x-del')!);
    fireEvent.click(container.querySelector('.del-yes')!);

    expect(onDelete).toHaveBeenCalledWith('target');
  });

  it('Cancel button disarms the row without calling onDelete', () => {
    const onDelete = vi.fn();
    const { container } = renderSidebar({
      sessions: [makeSession()],
      onDelete,
    });

    fireEvent.click(container.querySelector('.x-del')!);
    fireEvent.click(container.querySelector('.del-no')!);

    expect(onDelete).not.toHaveBeenCalled();
    // × is back, the confirm cluster is gone.
    expect(container.querySelector('.x-del')).toBeTruthy();
    expect(container.querySelector('.del-confirm')).toBeNull();
  });

  it('Escape disarms the row without calling onDelete', () => {
    const onDelete = vi.fn();
    const { container } = renderSidebar({ sessions: [makeSession()], onDelete });

    fireEvent.click(container.querySelector('.x-del')!);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onDelete).not.toHaveBeenCalled();
    expect(container.querySelector('.x-del')).toBeTruthy();
    expect(container.querySelector('.del-confirm')).toBeNull();
  });

  it('Enter confirms the armed row (keyboard flow)', () => {
    const onDelete = vi.fn();
    const { container } = renderSidebar({ sessions: [makeSession({ id: 'kbd' })], onDelete });

    fireEvent.click(container.querySelector('.x-del')!);
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(onDelete).toHaveBeenCalledWith('kbd');
  });

  it('mousedown outside the armed row disarms it', () => {
    const onDelete = vi.fn();
    const { container } = renderSidebar({ sessions: [makeSession()], onDelete });

    fireEvent.click(container.querySelector('.x-del')!);
    expect(container.querySelector('.del-confirm')).toBeTruthy();
    fireEvent.mouseDown(document.body);

    expect(container.querySelector('.del-confirm')).toBeNull();
    expect(container.querySelector('.x-del')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('clicking the row body while armed disarms it without calling onSelect', () => {
    const onSelect = vi.fn();
    const { container } = renderSidebar({
      sessions: [makeSession({ id: 'no-select-while-armed' })],
      onSelect,
      onDelete: () => {},
    });

    fireEvent.click(container.querySelector('.x-del')!);
    fireEvent.click(container.querySelector('.session .t')!);

    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector('.del-confirm')).toBeNull();
  });

  it('right-click on a row arms the inline confirm (default-prevented)', () => {
    const onDelete = vi.fn();
    const { container } = renderSidebar({ sessions: [makeSession({ id: 'ctx-target' })], onDelete });
    const row = container.querySelector('.session') as HTMLElement;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(row, ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(container.querySelector('.del-confirm')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('clicking Delete stops propagation so the row is NOT also selected', () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderSidebar({
      sessions: [makeSession({ id: 'combo' })],
      onDelete,
      onSelect,
    });

    fireEvent.click(container.querySelector('.x-del')!);
    fireEvent.click(container.querySelector('.del-yes')!);

    expect(onDelete).toHaveBeenCalledWith('combo');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clicking the row body (not the ×) still triggers onSelect', () => {
    const onSelect = vi.fn();
    const { container } = renderSidebar({
      sessions: [makeSession({ id: 'pick-me' })],
      onSelect,
      onDelete: () => {},
    });
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