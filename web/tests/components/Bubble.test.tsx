import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { Bubble, type Source, type Followup } from '../../src/components/Bubble';
import type { ToolCallRecord } from '../../src/types';

// p3-T16 — Bubble renders tool calls as a single collapsed "Tool
// use" line (ToolUseLine) when `toolCalls` is present on an
// assistant message. Click the head to expand a flat list of every
// call. The per-call ToolCallChip / ToolResultChip components from
// p3-T09 were removed with this commit.

function makeToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    name: 'get_chunk',
    arguments: { chunkId: 'abc' },
    result: { kind: 'chunks', chunks: [] },
    truncated: false,
    iteration: 0,
    ...overrides,
  };
}

describe('Bubble — tool use line (p3-T16)', () => {
  afterEach(() => cleanup());

  it('does NOT render the tool-use line when toolCalls is absent', () => {
    const { container } = render(<Bubble role="assistant" text="hello" />);
    expect(container.querySelector('.tool-use-line')).toBeNull();
  });

  it('does NOT render the tool-use line on user bubbles', () => {
    const { container } = render(
      <Bubble role="user" text="hi" toolCalls={[makeToolCall()]} />
    );
    expect(container.querySelector('.tool-use-line')).toBeNull();
  });

  it('renders the collapsed line by default when toolCalls is present', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[
          makeToolCall({ name: 'get_chunk', arguments: { chunkId: 'a' }, iteration: 0 }),
          makeToolCall({ name: 'get_document', arguments: { filePath: 'doc.md' }, iteration: 1 }),
        ]}
      />
    );
    const line = container.querySelector('.tool-use-line');
    expect(line).not.toBeNull();
    expect(line!.classList.contains('expanded')).toBe(false);
    const head = line!.querySelector('.tool-use-head') as HTMLButtonElement;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('Tool use');
    expect(head.textContent).toContain('2 calls');
    // Expanded panel not rendered yet
    expect(container.querySelector('.tool-use-list')).toBeNull();
  });

  it('shows iteration count when the agent loop ran more than once', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[
          makeToolCall({ name: 'get_chunk', iteration: 0 }),
          makeToolCall({ name: 'get_chunk', iteration: 1 }),
          makeToolCall({ name: 'get_document', iteration: 1 }),
        ]}
      />
    );
    const head = container.querySelector('.tool-use-head') as HTMLElement;
    expect(head.textContent).toContain('3 calls');
    expect(head.textContent).toContain('2 iterations');
  });

  it('omits the iteration count when the agent loop only ran once', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[makeToolCall({ name: 'get_chunk', iteration: 0 })]}
      />
    );
    const head = container.querySelector('.tool-use-head') as HTMLElement;
    expect(head.textContent).toContain('1 call');
    expect(head.textContent).not.toContain('iterations');
  });

  it('expands to a flat list of rows on click', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[
          makeToolCall({ name: 'get_chunk', arguments: { chunkId: 'a' }, iteration: 0 }),
          makeToolCall({ name: 'get_document', arguments: { filePath: 'doc.md' }, iteration: 1 }),
        ]}
      />
    );
    const head = container.querySelector('.tool-use-head') as HTMLButtonElement;
    fireEvent.click(head);
    const line = container.querySelector('.tool-use-line')!;
    expect(line.classList.contains('expanded')).toBe(true);
    expect(head.getAttribute('aria-expanded')).toBe('true');

    const list = container.querySelector('.tool-use-list');
    expect(list).not.toBeNull();
    const rows = container.querySelectorAll('.tool-use-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.tool-use-row-name')?.textContent).toBe('get_chunk');
    expect(rows[1]!.querySelector('.tool-use-row-name')?.textContent).toBe('get_document');
  });

  it('summarizes each row with the result kind', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[
          // 3 chunks
          makeToolCall({
            name: 'get_chunk',
            arguments: { chunkId: 'a' },
            result: {
              kind: 'chunks',
              chunks: [
                { chunkId: '1', fileName: 'a.md', filePath: 'a.md', chunkIndex: 0, totalChunks: 1, text: 'a' },
                { chunkId: '2', fileName: 'a.md', filePath: 'a.md', chunkIndex: 1, totalChunks: 1, text: 'b' },
                { chunkId: '3', fileName: 'a.md', filePath: 'a.md', chunkIndex: 2, totalChunks: 1, text: 'c' },
              ],
              truncated: false,
            },
            iteration: 0,
          }),
          // error
          makeToolCall({
            name: 'get_document',
            arguments: { filePath: 'missing.pdf' },
            result: { kind: 'error', code: 'NOT_FOUND', message: 'Document not found' },
            iteration: 1,
          }),
        ]}
      />
    );
    const head = container.querySelector('.tool-use-head') as HTMLButtonElement;
    fireEvent.click(head);
    const rows = container.querySelectorAll('.tool-use-row');
    expect(rows[0]!.querySelector('.tool-use-row-result')?.textContent).toContain('3 chunks');
    expect(rows[1]!.querySelector('.tool-use-row-result')?.textContent).toContain('error: Document not found');
  });

  it('shows a truncated badge when a tool result was truncated', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[
          makeToolCall({
            name: 'get_chunk',
            arguments: { chunkId: 'a' },
            result: { kind: 'chunks', chunks: [], truncated: true },
            truncated: true,
            iteration: 0,
          }),
        ]}
      />
    );
    fireEvent.click(container.querySelector('.tool-use-head') as HTMLButtonElement);
    const badge = container.querySelector('.tool-use-truncated');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('truncated');
  });

  it('keeps the assistant text rendering alongside the tool use line', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="Here is the answer"
        toolCalls={[makeToolCall()]}
      />
    );
    expect(container.querySelector('.text')).not.toBeNull();
    expect(container.querySelector('.tool-use-line')).not.toBeNull();
    expect(container.textContent).toContain('Here is the answer');
  });

  it('renders source chips and the tool use line independently', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[makeToolCall()]}
        sources={[
          {
            id: 's1',
            number: 1,
            fileName: 'a.md',
            filePath: 'a.md',
            chunk: 'x',
            score: 0.9,
          },
        ]}
      />
    );
    expect(container.querySelector('.srcs')).not.toBeNull();
    expect(container.querySelector('.tool-use-line')).not.toBeNull();
  });

  it('renders a "no document" row for get_document returning null', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[
          makeToolCall({
            name: 'get_document',
            arguments: { filePath: 'gone.pdf' },
            result: { kind: 'document', document: null },
            iteration: 0,
          }),
        ]}
      />
    );
    fireEvent.click(container.querySelector('.tool-use-head') as HTMLButtonElement);
    const result = container.querySelector('.tool-use-row-result')?.textContent ?? '';
    expect(result).toContain('no document');
  });

  it('handles an unknown tool name in the default-case args preview', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[
          makeToolCall({
            name: 'mystery_tool',
            arguments: { foo: 'bar', baz: 42 },
            iteration: 0,
          }),
        ]}
      />
    );
    fireEvent.click(container.querySelector('.tool-use-head') as HTMLButtonElement);
    const args = container.querySelector('.tool-use-row-args')?.textContent ?? '';
    expect(args).toContain('foo=bar');
    expect(args).toContain('baz=42');
  });

  it('falls back to the tool name when summarizeResult gets an unknown shape', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[
          makeToolCall({
            name: 'mystery',
            arguments: {},
            // Not one of the structured AgentToolResult shapes — falls
            // through to the `return truncated ? … : name` branch.
            result: { unexpected: 'shape' },
            truncated: true,
            iteration: 0,
          }),
        ]}
      />
    );
    fireEvent.click(container.querySelector('.tool-use-head') as HTMLButtonElement);
    const result = container.querySelector('.tool-use-row-result')?.textContent ?? '';
    expect(result).toContain('mystery');
    expect(result).toContain('truncated');
  });

  it('does not render the tool use line for assistant bubbles with empty toolCalls', () => {
    const { container } = render(
      <Bubble role="assistant" text="answer" toolCalls={[]} />
    );
    expect(container.querySelector('.tool-use-line')).toBeNull();
  });

  it('renders source chips with fileName + page when sources are provided', () => {
    let clickedSource: Source | null = null;
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        sources={[
          {
            id: 's1',
            number: 1,
            fileName: 'a.md',
            filePath: 'a.md',
            page: 'p.3',
            pageNumber: 3,
            chunk: 'x',
            score: 0.9,
          },
        ]}
        onSourceClick={(s) => {
          clickedSource = s;
        }}
      />
    );
    const chip = container.querySelector('.srcs .chip') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain('[1]');
    expect(chip.textContent).toContain('a.md');
    expect(chip.textContent).toContain('p.3');
    fireEvent.click(chip);
    expect(clickedSource?.id).toBe('s1');
  });

  it('renders followup chips and calls onFollowupClick when one is clicked', () => {
    let clickedFollowup: Followup | null = null;
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        followups={[{ id: 'f1', text: 'Tell me more' }]}
        onFollowupClick={(f) => {
          clickedFollowup = f;
        }}
      />
    );
    const chip = container.querySelector('.followups .followup') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain('Tell me more');
    fireEvent.click(chip);
    expect(clickedFollowup?.id).toBe('f1');
  });
});