import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, type RenderResult } from '@testing-library/preact';
import { Chat } from '../../src/routes/Chat';
import type { Conversation, Message } from '../../src/services/sessions';
import type { ServerStatus } from '../../src/services/status';

// p2-T26 — auto-scroll the chat stream to the bottom when a session
// loads. We don't test this via curl because scroll position is a
// DOM state, not an API observable. Happy-dom gives us a real DOM,
// scrollHeight/clientHeight/s scrollTo are all functional, and the
// only thing we need to stub is the size of the stream (so the
// scrollTop we set is observable).

function makeSession(id: string): Conversation {
  return {
    id,
    title: `Session ${id}`,
    titleSource: 'default',
    createdAt: '2024-01-01 00:00:00',
    updatedAt: '2024-01-01 00:00:00',
    messageCount: 0,
  };
}

function makeMessage(
  role: 'user' | 'assistant',
  content: string,
  conversationId = 's1'
): Message {
  return {
    id: Math.random().toString(36).slice(2),
    conversationId,
    role,
    content,
    createdAt: '2024-01-01 00:00:00',
  };
}

const NOOP_STATUS: ServerStatus | null = null;

// The scroll effect schedules scrollTo via requestAnimationFrame, so
// we need to drain two rAFs to be sure the scroll has actually fired.
function flushRaf(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function setStreamSize(
  stream: HTMLElement,
  scrollHeight: number,
  clientHeight: number
): void {
  Object.defineProperty(stream, 'scrollHeight', {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(stream, 'clientHeight', {
    value: clientHeight,
    configurable: true,
  });
}

function renderChat(
  ui: Parameters<typeof render>[0]
): RenderResult & { stream: HTMLElement } {
  const result = render(ui);
  const stream = result.container.querySelector('.stream') as HTMLElement;
  if (!stream) throw new Error('.stream element not found');
  return { ...result, stream };
}

describe('Chat scroll-to-bottom (p2-T26)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('scrolls the stream to the bottom on initial mount with messages', async () => {
    const scrollSpy = vi.fn();
    const origScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollSpy;

    try {
      const session = makeSession('s1');
      const messages: Message[] = [
        makeMessage('user', 'hi', session.id),
        makeMessage('assistant', 'hello there', session.id),
      ];

      const { stream } = renderChat(
        <Chat
          activeSession={session}
          loading={false}
          messages={messages}
          pending={null}
          onSubmit={() => {}}
          status={NOOP_STATUS}
        />
      );

      setStreamSize(stream, 1000, 400);

      await flushRaf();

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.calls[0]?.[0]).toMatchObject({
        top: 1000,
        behavior: 'auto',
      });
    } finally {
      HTMLElement.prototype.scrollTo = origScrollTo;
    }
  });

  it('does not scroll again when messages grow during streaming', async () => {
    const scrollSpy = vi.fn();
    const origScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollSpy;

    try {
      const session = makeSession('s1');
      const initialMessages: Message[] = [makeMessage('user', 'hi', session.id)];

      const { stream, rerender } = renderChat(
        <Chat
          activeSession={session}
          loading={false}
          messages={initialMessages}
          pending={null}
          onSubmit={() => {}}
          status={NOOP_STATUS}
        />
      );

      setStreamSize(stream, 1000, 400);

      await flushRaf();

      expect(scrollSpy).toHaveBeenCalledTimes(1);

      // Simulate the user scrolling up to read history while a
      // response is streaming in. The stream's scrollTop should
      // stay where the user put it.
      stream.scrollTop = 200;

      const moreMessages: Message[] = [
        ...initialMessages,
        makeMessage('assistant', 'first reply chunk', session.id),
      ];

      rerender(
        <Chat
          activeSession={session}
          loading={false}
          messages={moreMessages}
          pending={null}
          onSubmit={() => {}}
          status={NOOP_STATUS}
        />
      );

      await flushRaf();

      // No new scrollTo call — we leave the user's reading position alone.
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(stream.scrollTop).toBe(200);
    } finally {
      HTMLElement.prototype.scrollTo = origScrollTo;
    }
  });

  it('scrolls to the bottom when switching to a different session', async () => {
    const scrollSpy = vi.fn();
    const origScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollSpy;

    try {
      const sessionA = makeSession('s1');
      const sessionB = makeSession('s2');
      const messagesA: Message[] = [makeMessage('user', 'first A', sessionA.id)];
      const messagesB: Message[] = [
        makeMessage('user', 'first B', sessionB.id),
        makeMessage('assistant', 'B reply 1', sessionB.id),
        makeMessage('user', 'B follow-up', sessionB.id),
        makeMessage('assistant', 'B reply 2', sessionB.id),
      ];

      const { stream, rerender } = renderChat(
        <Chat
          activeSession={sessionA}
          loading={false}
          messages={messagesA}
          pending={null}
          onSubmit={() => {}}
          status={NOOP_STATUS}
        />
      );

      setStreamSize(stream, 800, 400);

      await flushRaf();

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.calls[0]?.[0]).toMatchObject({ top: 800 });

      // User scrolls up before switching (preserved across rerender).
      stream.scrollTop = 50;

      // Switch sessions — and simulate the new session's history
      // being a different height.
      setStreamSize(stream, 1500, 400);

      rerender(
        <Chat
          activeSession={sessionB}
          loading={false}
          messages={messagesB}
          pending={null}
          onSubmit={() => {}}
          status={NOOP_STATUS}
        />
      );

      await flushRaf();

      expect(scrollSpy).toHaveBeenCalledTimes(2);
      expect(scrollSpy.mock.calls[1]?.[0]).toMatchObject({ top: 1500 });
    } finally {
      HTMLElement.prototype.scrollTo = origScrollTo;
    }
  });

  it('does not scroll while a session is still loading its messages', async () => {
    const scrollSpy = vi.fn();
    const origScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollSpy;

    try {
      // loading=true simulates the brief window where the active
      // session id is set but listMessages hasn't returned yet.
      const session = makeSession('s1');

      const { stream } = renderChat(
        <Chat
          activeSession={session}
          loading={true}
          messages={[]}
          pending={null}
          onSubmit={() => {}}
          status={NOOP_STATUS}
        />
      );

      setStreamSize(stream, 1000, 400);

      await flushRaf();

      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollTo = origScrollTo;
    }
  });

  it('scrolls after a session-switch race: id set before messages arrive', async () => {
    // selectSession() in App.tsx does setActiveId(id); setMessages([]);
    // then awaits listMessages. The Chat effect fires once when the
    // id changes (with messages.length === 0 → bail), then again when
    // messages arrive. We must not lock out the second run by setting
    // lastScrolledFor on the first, empty run.
    const scrollSpy = vi.fn();
    const origScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollSpy;

    try {
      const session = makeSession('s1');

      const { stream, rerender } = renderChat(
        <Chat
          activeSession={session}
          loading={true}
          messages={[]}
          pending={null}
          onSubmit={() => {}}
          status={NOOP_STATUS}
        />
      );

      setStreamSize(stream, 1000, 400);

      await flushRaf();

      // Empty stream — no scroll yet, no lastScrolledFor written.
      expect(scrollSpy).not.toHaveBeenCalled();

      // Messages arrive, loading clears.
      const messages: Message[] = [
        makeMessage('user', 'first', session.id),
        makeMessage('assistant', 'reply', session.id),
      ];

      rerender(
        <Chat
          activeSession={session}
          loading={false}
          messages={messages}
          pending={null}
          onSubmit={() => {}}
          status={NOOP_STATUS}
        />
      );

      await flushRaf();

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.calls[0]?.[0]).toMatchObject({ top: 1000 });
    } finally {
      HTMLElement.prototype.scrollTo = origScrollTo;
    }
  });
});