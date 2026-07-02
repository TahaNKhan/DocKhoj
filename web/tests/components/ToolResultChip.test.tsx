import { describe, it, expect } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { ToolResultChip } from '../../src/components/ToolResultChip';

// Phase 03 / p3-T09 — ToolResultChip renders a one-line summary
// (n chunks / metadata / error) collapsed and the full result JSON
// when expanded.

describe('ToolResultChip', () => {
  it('summarizes chunks results as "N chunks"', () => {
    const { container } = render(
      <ToolResultChip
        name="get_chunk"
        result={{ kind: 'chunks', chunks: [{}, {}, {}], truncated: false }}
        truncated={false}
        iteration={0}
      />
    );
    expect(container.querySelector('.tool-summary')?.textContent).toBe('3 chunks');
  });

  it('summarizes a single chunk result as "1 chunk"', () => {
    const { container } = render(
      <ToolResultChip
        name="get_section_chunks"
        result={{ kind: 'chunks', chunks: [{}], truncated: false }}
        truncated={false}
        iteration={0}
      />
    );
    expect(container.querySelector('.tool-summary')?.textContent).toBe('1 chunk');
  });

  it('summarizes document results as "metadata"', () => {
    const { container } = render(
      <ToolResultChip
        name="get_document"
        result={{ kind: 'document', document: { fileName: 'a.md' } }}
        truncated={false}
        iteration={0}
      />
    );
    expect(container.querySelector('.tool-summary')?.textContent).toBe('metadata');
  });

  it('summarizes error results as "error: <message>"', () => {
    const { container } = render(
      <ToolResultChip
        name="get_chunk"
        result={{ kind: 'error', code: 'NOT_FOUND', message: 'chunk gone' }}
        truncated={false}
        iteration={0}
      />
    );
    expect(container.querySelector('.tool-summary')?.textContent).toBe('error: chunk gone');
  });

  it('shows the truncated badge when truncated is true', () => {
    const { container } = render(
      <ToolResultChip
        name="get_chunk"
        result={{ kind: 'chunks', chunks: [] }}
        truncated={true}
        iteration={0}
      />
    );
    expect(container.querySelector('.tool-truncated')).not.toBeNull();
  });

  it('omits the truncated badge when truncated is false', () => {
    const { container } = render(
      <ToolResultChip
        name="get_chunk"
        result={{ kind: 'chunks', chunks: [] }}
        truncated={false}
        iteration={0}
      />
    );
    expect(container.querySelector('.tool-truncated')).toBeNull();
  });

  it('collapses by default and expands on click', () => {
    const { container } = render(
      <ToolResultChip
        name="get_chunk"
        result={{ kind: 'chunks', chunks: [{ text: 'hello' }] }}
        truncated={false}
        iteration={0}
      />
    );
    expect(container.querySelector('.tool-chip-body')).toBeNull();
    fireEvent.click(container.querySelector('.tool-chip-head') as HTMLButtonElement);
    const body = container.querySelector('.tool-chip-body');
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain('hello');
  });

  it('shows the iteration + name in the chip header', () => {
    const { container } = render(
      <ToolResultChip
        name="get_chunk"
        result={{ kind: 'chunks', chunks: [] }}
        truncated={false}
        iteration={1}
      />
    );
    expect(container.querySelector('.tool-name')?.textContent).toBe('get_chunk');
    expect(container.querySelector('.tool-iter')?.textContent).toBe('iter 2');
  });
});
