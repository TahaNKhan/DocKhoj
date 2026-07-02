import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { DocSourceDrawer } from '../../src/components/DocSourceDrawer';
import type { DocSourceGroup, Source } from '../../src/components/Bubble';

// p3-T18 — DocSourceDrawer. Companion to SourceDrawer; renders
// one document's chunks at once. The drawer:
//   1. Renders nothing when docSources is null.
//   2. Shows the file name, chunk count, and a row per chunk.
//   3. Renders the first chunk's markdown by default.
//   4. Clicking a different chunk in the list swaps the rendered
//      markdown to that chunk's content.
//   5. Closes on × button, backdrop click, or ESC keydown.
//   6. Points "Open file" at /api/download/<encoded filePath>.

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: `src-${Math.random().toString(36).slice(2)}`,
    number: 1,
    fileName: 'attention.pdf',
    filePath: 'attention.pdf',
    page: 'p.3',
    pageNumber: 3,
    headingPath: ['Transformers', 'Architecture'],
    chunk: '**bold** opening line.',
    score: 0.873,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<DocSourceGroup> = {}): DocSourceGroup {
  return {
    fileName: 'attention.pdf',
    filePath: 'attention.pdf',
    chunks: [
      makeSource({ id: 's1', number: 1, page: 'p.3', score: 0.873 }),
      makeSource({
        id: 's2',
        number: 2,
        page: 'p.5',
        score: 0.751,
        chunk: 'second chunk body',
        headingPath: ['Transformers', 'Outputs'],
      }),
      makeSource({
        id: 's3',
        number: 3,
        page: 'p.7',
        score: 0.602,
        chunk: 'third chunk body',
      }),
    ],
    ...overrides,
  };
}

describe('DocSourceDrawer', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when docSources is null', () => {
    const { container } = render(
      <DocSourceDrawer docSources={null} onClose={() => {}} />
    );
    expect(container.querySelector('.doc-source-drawer')).toBeNull();
    expect(container.querySelector('.drawer-backdrop')).toBeNull();
  });

  it('renders the file name, chunk count, and one row per chunk', () => {
    const { container } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={() => {}} />
    );
    const drawer = container.querySelector('.doc-source-drawer');
    expect(drawer).not.toBeNull();

    expect(drawer?.textContent).toContain('attention.pdf');
    expect(drawer?.textContent).toContain('3 chunks');

    const rows = drawer!.querySelectorAll('.doc-chunk-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('.doc-chunk-page')?.textContent).toBe('p.3');
    expect(rows[1]!.querySelector('.doc-chunk-page')?.textContent).toBe('p.5');
    expect(rows[2]!.querySelector('.doc-chunk-page')?.textContent).toBe('p.7');
  });

  it('uses singular "chunk" when there is exactly one chunk', () => {
    const group = makeGroup({
      chunks: [makeSource({ id: 's1' })],
    });
    const { container } = render(
      <DocSourceDrawer docSources={group} onClose={() => {}} />
    );
    expect(container.textContent).toContain('1 chunk');
    expect(container.textContent).not.toContain('1 chunks');
  });

  it('renders the first chunk\'s markdown by default', () => {
    const { container } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={() => {}} />
    );
    const body = container.querySelector('.source-drawer .chunk');
    expect(body?.querySelector('strong')?.textContent).toBe('bold');
  });

  it('marks the active chunk in the list', () => {
    const { container } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={() => {}} />
    );
    const rows = container.querySelectorAll('.doc-chunk-row');
    expect(rows[0]!.classList.contains('active')).toBe(true);
    expect(rows[1]!.classList.contains('active')).toBe(false);
    expect(rows[2]!.classList.contains('active')).toBe(false);
  });

  it('swaps the rendered markdown when a different chunk is clicked', () => {
    const { container } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={() => {}} />
    );
    const rows = container.querySelectorAll('.doc-chunk-row');
    fireEvent.click(rows[1] as HTMLElement);

    const body = container.querySelector('.source-drawer .chunk');
    expect(body?.textContent).toContain('second chunk body');
    // First row no longer active, second row is.
    expect(rows[0]!.classList.contains('active')).toBe(false);
    expect(rows[1]!.classList.contains('active')).toBe(true);
  });

  it('resets to the first chunk when a different doc is opened', () => {
    const { container, rerender } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={() => {}} />
    );
    // Pick a non-default chunk.
    const rows = container.querySelectorAll('.doc-chunk-row');
    fireEvent.click(rows[2] as HTMLElement);
    expect(rows[2]!.classList.contains('active')).toBe(true);

    // Open a different doc group.
    const otherGroup: DocSourceGroup = {
      fileName: 'other.pdf',
      filePath: 'other.pdf',
      chunks: [makeSource({ id: 'o1', number: 9, page: 'p.1', score: 0.5 })],
    };
    rerender(<DocSourceDrawer docSources={otherGroup} onClose={() => {}} />);

    const newRows = container.querySelectorAll('.doc-chunk-row');
    expect(newRows).toHaveLength(1);
    expect(newRows[0]!.classList.contains('active')).toBe(true);
  });

  it('shows the active chunk\'s heading path in the drawer head', () => {
    const { container } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={() => {}} />
    );
    expect(container.querySelector('.source-drawer .crumbs')?.textContent).toContain(
      'Transformers'
    );
    expect(container.querySelector('.source-drawer .crumbs')?.textContent).toContain(
      'Architecture'
    );
  });

  it('shows the em-dash placeholder for chunks without a page label', () => {
    const group = makeGroup({
      chunks: [makeSource({ id: 's1', page: undefined, pageNumber: undefined })],
    });
    const { container } = render(
      <DocSourceDrawer docSources={group} onClose={() => {}} />
    );
    const page = container.querySelector('.doc-chunk-page');
    expect(page?.textContent).toBe('—');
    expect(page?.classList.contains('doc-chunk-page--empty')).toBe(true);
  });

  it('shows the score formatted to 3 decimal places', () => {
    const { container } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={() => {}} />
    );
    // Active chunk (first) score: 0.873.
    expect(container.querySelector('.source-drawer .score')?.textContent).toBe(
      'score 0.873'
    );
  });

  it('points the "Open file" link at /api/download/<encoded filePath>', () => {
    const group = makeGroup({ filePath: 'with spaces & weird.pdf' });
    const { container } = render(
      <DocSourceDrawer docSources={group} onClose={() => {}} />
    );
    const link = container.querySelector<HTMLAnchorElement>(
      '.source-drawer .open-file'
    );
    expect(link?.getAttribute('href')).toBe(
      '/api/download/with%20spaces%20%26%20weird.pdf'
    );
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('omits the "Open file" link when filePath is empty', () => {
    const group = makeGroup({ filePath: '' });
    const { container } = render(
      <DocSourceDrawer docSources={group} onClose={() => {}} />
    );
    expect(container.querySelector('.source-drawer .open-file')).toBeNull();
  });

  it('closes on × button click', () => {
    const onClose = vi.fn();
    const { container } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={onClose} />
    );
    fireEvent.click(container.querySelector('.close-x') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    const { container } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={onClose} />
    );
    fireEvent.click(container.querySelector('.drawer-backdrop') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on ESC keydown', () => {
    const onClose = vi.fn();
    render(<DocSourceDrawer docSources={makeGroup()} onClose={onClose} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not register an ESC listener when docSources is null', () => {
    const onClose = vi.fn();
    render(<DocSourceDrawer docSources={null} onClose={onClose} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes the ESC listener when the drawer unmounts', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <DocSourceDrawer docSources={makeGroup()} onClose={onClose} />
    );
    unmount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the last heading-path element as the chip crumb', () => {
    const group: DocSourceGroup = {
      fileName: 'attention.pdf',
      filePath: 'attention.pdf',
      chunks: [
        makeSource({
          id: 's1',
          number: 1,
          page: 'p.3',
          headingPath: ['Transformers', 'Architecture'],
        }),
        makeSource({
          id: 's2',
          number: 2,
          page: 'p.5',
          headingPath: ['Transformers', 'Outputs'],
        }),
        makeSource({
          id: 's3',
          number: 3,
          page: 'p.7',
          headingPath: undefined, // chunk 3 has no headingPath
        }),
      ],
    };
    const { container } = render(
      <DocSourceDrawer docSources={group} onClose={() => {}} />
    );
    const crumbs = container.querySelectorAll('.doc-chunk-row .doc-chunk-crumb');
    expect(crumbs).toHaveLength(2); // chunk 3 has no heading → no crumb span
    expect(crumbs[0]!.textContent).toBe('Architecture');
    expect(crumbs[1]!.textContent).toBe('Outputs');
  });
});