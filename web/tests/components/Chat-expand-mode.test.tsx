import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { Chat } from '../../src/routes/Chat';
import type { Conversation, Message } from '../../src/services/sessions';

// Phase 03 / p3-T10 — Chat toolbar expand-mode toggle.
//
// The Chat component owns the expand mode and persists it to
// localStorage under 'dockhoj.expandMode'. The toolbar renders a
// chip + popover; selecting an option fires onSubmit with the new
// mode.

function makeSession(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'sess-1',
    title: 'My chat',
    titleSource: 'default',
    createdAt: '2026-07-01 09:00:00',
    updatedAt: '2026-07-01 10:00:00',
    messageCount: 0,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    conversationId: 'sess-1',
    role: 'user',
    content: 'hello',
    createdAt: '2026-07-01 10:00:00',
    ...overrides,
  };
}

describe('Chat — expand-mode toggle', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the toggle chip in the toolbar', () => {
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    const chip = container.querySelector('.expand-toggle .mode-chip');
    expect(chip).not.toBeNull();
  });

  it('defaults to Auto when no localStorage entry is present', () => {
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    const label = container.querySelector('.mode-chip-label')?.textContent;
    expect(label).toBe('Auto');
  });

  it('reads the persisted mode from localStorage on mount', () => {
    localStorage.setItem('dockhoj.expandMode', 'none');
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    expect(container.querySelector('.mode-chip-label')?.textContent).toBe('None');
  });

  it('clicking the chip opens the popover with all four options', () => {
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    const chip = container.querySelector('.mode-chip') as HTMLButtonElement;
    fireEvent.click(chip);
    const popover = container.querySelector('.mode-popover');
    expect(popover).not.toBeNull();
    const options = popover!.querySelectorAll('button[role="option"]');
    expect(options).toHaveLength(4);
    const labels = Array.from(options).map((o) => o.querySelector('.mode-name')?.textContent);
    expect(labels).toEqual(['None', 'Siblings', 'Sections', 'Auto']);
  });

  it('selecting an option closes the popover, updates the chip, and writes localStorage', () => {
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    fireEvent.click(container.querySelector('.mode-chip') as HTMLButtonElement);
    const options = container.querySelectorAll('.mode-popover button[role="option"]');
    const noneOption = Array.from(options).find(
      (o) => o.querySelector('.mode-name')?.textContent === 'None'
    ) as HTMLButtonElement;
    fireEvent.click(noneOption);
    // popover closed
    expect(container.querySelector('.mode-popover')).toBeNull();
    // chip updated
    expect(container.querySelector('.mode-chip-label')?.textContent).toBe('None');
    // localStorage written
    expect(localStorage.getItem('dockhoj.expandMode')).toBe('none');
  });

  it('marks the currently-selected option with aria-selected=true', () => {
    localStorage.setItem('dockhoj.expandMode', 'sections');
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    fireEvent.click(container.querySelector('.mode-chip') as HTMLButtonElement);
    const options = container.querySelectorAll('.mode-popover button[role="option"]');
    const sections = Array.from(options).find(
      (o) => o.querySelector('.mode-name')?.textContent === 'Sections'
    );
    expect(sections?.getAttribute('aria-selected')).toBe('true');
    expect(sections?.classList.contains('selected')).toBe(true);
  });

  it('passes the selected mode to onSubmit when the user sends a message', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={onSubmit}
        status={null}
      />
    );
    // Default is Auto. Type something into the composer.
    const ta = container.querySelector('.composer textarea') as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello', { expand: 'auto' });
  });

  it('passes the persisted mode to onSubmit after a refresh', () => {
    localStorage.setItem('dockhoj.expandMode', 'none');
    const onSubmit = vi.fn();
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={onSubmit}
        status={null}
      />
    );
    const ta = container.querySelector('.composer textarea') as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: 'q' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('q', { expand: 'none' });
  });

  it('ignores unknown values in localStorage and falls back to Auto', () => {
    localStorage.setItem('dockhoj.expandMode', 'subliminal-channels');
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    expect(container.querySelector('.mode-chip-label')?.textContent).toBe('Auto');
  });

  it('clicking the chip a second time closes the popover (toggle behavior)', () => {
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    const chip = container.querySelector('.mode-chip') as HTMLButtonElement;
    fireEvent.click(chip);
    expect(container.querySelector('.mode-popover')).not.toBeNull();
    fireEvent.click(chip);
    expect(container.querySelector('.mode-popover')).toBeNull();
  });

  it('marks the chip aria-expanded=true while the popover is open', () => {
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={[]}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    const chip = container.querySelector('.mode-chip') as HTMLButtonElement;
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders existing history messages without the chat surface blowing up', () => {
    const messages: Message[] = [
      makeMessage({ id: 'm1', role: 'user', content: 'hi' }),
      makeMessage({
        id: 'm2',
        role: 'assistant',
        content: 'hello',
        sources: [
          {
            fileName: 'a.md',
            filePath: 'a.md',
            chunk: 'x',
            score: 0.9,
          },
        ],
      }),
    ];
    const { container } = render(
      <Chat
        activeSession={makeSession()}
        loading={false}
        messages={messages}
        pending={null}
        onSubmit={() => {}}
        status={null}
      />
    );
    expect(container.querySelectorAll('.bubble')).toHaveLength(2);
  });
});