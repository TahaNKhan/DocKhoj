import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { Bubble } from '../../src/components/Bubble';
import type { ToolCallRecord } from '../../src/types';

// Phase 03 / p3-T09 — Bubble renders tool-call chips when
// `toolCalls` is provided on an assistant message. Each chip is a
// ToolCallChip instance with the tool name + an args preview.

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

describe('Bubble — tool-call chips', () => {
  afterEach(() => cleanup());

  it('does NOT render the tools row when toolCalls is absent', () => {
    const { container } = render(<Bubble role="assistant" text="hello" />);
    expect(container.querySelector('.tools')).toBeNull();
  });

  it('renders a chip per toolCall when toolCalls is present', () => {
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
    const chips = container.querySelectorAll('.tools .tool-chip.call');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.querySelector('.tool-name')?.textContent).toBe('get_chunk');
    expect(chips[1]!.querySelector('.tool-name')?.textContent).toBe('get_document');
  });

  it('does NOT render tool chips on user bubbles', () => {
    const { container } = render(
      <Bubble role="user" text="hi" toolCalls={[makeToolCall()]} />
    );
    expect(container.querySelector('.tools')).toBeNull();
  });

  it('expands a chip on click to show arguments + result', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="answer"
        toolCalls={[makeToolCall({ arguments: { chunkId: 'abc' } })]}
      />
    );
    const head = container.querySelector('.tool-chip-head') as HTMLButtonElement;
    fireEvent.click(head);
    const body = container.querySelector('.tool-chip-body');
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain('"chunkId": "abc"');
  });

  it('keeps the assistant text rendering alongside the tools row', () => {
    const { container } = render(
      <Bubble
        role="assistant"
        text="Here is the answer"
        toolCalls={[makeToolCall()]}
      />
    );
    expect(container.querySelector('.text')).not.toBeNull();
    expect(container.querySelector('.tools')).not.toBeNull();
    expect(container.textContent).toContain('Here is the answer');
  });

  it('renders sources chips and tool chips independently', () => {
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
    expect(container.querySelector('.tools')).not.toBeNull();
  });
});