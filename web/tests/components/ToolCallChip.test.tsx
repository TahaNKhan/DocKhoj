import { describe, it, expect } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { ToolCallChip } from '../../src/components/ToolCallChip';
import type { ToolCallRecord } from '../../src/types';

// Phase 03 / p3-T09 — ToolCallChip renders one record per chip.
// Collapsed: shows name + args preview + iter badge. Expanded:
// full arguments JSON + the result JSON.

function makeToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    name: 'get_chunk',
    arguments: { chunkId: 'chunk-xyz' },
    result: { kind: 'chunks', chunks: [{ chunkId: 'chunk-xyz', text: 'hello' }], truncated: false },
    truncated: false,
    iteration: 0,
    ...overrides,
  };
}

describe('ToolCallChip', () => {
  it('renders collapsed by default with name + iter + summary', () => {
    const { container } = render(<ToolCallChip toolCall={makeToolCall()} />);
    expect(container.querySelector('.tool-chip.call')).not.toBeNull();
    expect(container.querySelector('.tool-name')?.textContent).toContain('get_chunk');
    expect(container.querySelector('.tool-iter')?.textContent).toBe('iter 1');
    expect(container.querySelector('.tool-summary')?.textContent).toContain('chunkId=chunk-xyz');
    // The expanded body is absent until clicked.
    expect(container.querySelector('.tool-chip-body')).toBeNull();
  });

  it('expands on click to show arguments + result', () => {
    const { container } = render(
      <ToolCallChip
        toolCall={makeToolCall({
          arguments: { filePath: 'doc.md', chunkIndex: 5, range: 2 },
          name: 'get_neighbor_chunks',
        })}
      />
    );
    const head = container.querySelector('.tool-chip-head') as HTMLButtonElement;
    fireEvent.click(head);
    const body = container.querySelector('.tool-chip-body');
    expect(body).not.toBeNull();
    const args = body!.querySelector('.tool-args') as HTMLElement;
    expect(args.textContent).toContain('"filePath": "doc.md"');
    expect(args.textContent).toContain('"chunkIndex": 5');
    const result = body!.querySelector('.tool-result') as HTMLElement;
    expect(result.textContent).toContain('"kind"');
    expect(result.textContent).toContain('chunk-xyz');
  });

  it('toggles back to collapsed on a second click', () => {
    const { container } = render(<ToolCallChip toolCall={makeToolCall()} />);
    const head = container.querySelector('.tool-chip-head') as HTMLButtonElement;
    fireEvent.click(head);
    expect(container.querySelector('.tool-chip-body')).not.toBeNull();
    fireEvent.click(head);
    expect(container.querySelector('.tool-chip-body')).toBeNull();
  });

  it('shows a truncated badge when toolCall.truncated is true', () => {
    const { container } = render(
      <ToolCallChip toolCall={makeToolCall({ truncated: true })} />
    );
    expect(container.querySelector('.tool-truncated')).not.toBeNull();
  });

  it('omits the truncated badge when not truncated', () => {
    const { container } = render(
      <ToolCallChip toolCall={makeToolCall({ truncated: false })} />
    );
    expect(container.querySelector('.tool-truncated')).toBeNull();
  });

  it('formats section_chunks args with a / heading separator', () => {
    const { container } = render(
      <ToolCallChip
        toolCall={makeToolCall({
          name: 'get_section_chunks',
          arguments: { filePath: 'doc.md', headingPath: ['Chapter 2', 'Setup'] },
        })}
      />
    );
    const summary = container.querySelector('.tool-summary')?.textContent ?? '';
    expect(summary).toContain('Chapter 2 / Setup');
  });

  it('formats get_neighbor_chunks with chunkIndex and range', () => {
    const { container } = render(
      <ToolCallChip
        toolCall={makeToolCall({
          name: 'get_neighbor_chunks',
          arguments: { filePath: 'doc.md', chunkIndex: 5, range: 3 },
        })}
      />
    );
    const summary = container.querySelector('.tool-summary')?.textContent ?? '';
    expect(summary).toContain('chunkIndex=5');
    expect(summary).toContain('range=3');
  });

  it('renders the iteration as iter (n+1)', () => {
    const { container } = render(
      <ToolCallChip toolCall={makeToolCall({ iteration: 2 })} />
    );
    expect(container.querySelector('.tool-iter')?.textContent).toBe('iter 3');
  });
});
