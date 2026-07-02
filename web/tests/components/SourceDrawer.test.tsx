import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { SourceDrawer } from '../../src/components/SourceDrawer';
import type { Source } from '../../src/components/Bubble';

// p2-T16 — SourceDrawer. The drawer should:
//   1. Render nothing when source is null.
//   2. Render the chunk, metadata, and download link when open.
//   3. Close on ESC.
//   4. Close on backdrop click.
//   5. Close on × button click.
//   6. Point the "Open file" link at /api/download/<encoded filePath>.

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src1',
    number: 1,
    fileName: 'attention.pdf',
    filePath: 'attention.pdf',
    page: 'p.3',
    pageNumber: 3,
    headingPath: ['Transformers', 'Architecture'],
    chunk: 'The model uses **self-attention** to relate all positions.',
    score: 0.873,
    ...overrides,
  };
}

describe('SourceDrawer', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when source is null', () => {
    const { container } = render(
      <SourceDrawer source={null} onClose={() => {}} />
    );
    expect(container.querySelector('.source-drawer')).toBeNull();
    expect(container.querySelector('.drawer-backdrop')).toBeNull();
  });

  it('renders the file name, page, heading crumbs, and chunk text', () => {
    const { container } = render(
      <SourceDrawer source={makeSource()} onClose={() => {}} />
    );
    const drawer = container.querySelector('.source-drawer');
    expect(drawer).not.toBeNull();

    expect(drawer?.textContent).toContain('attention.pdf');
    expect(drawer?.textContent).toContain('p.3');
    expect(drawer?.textContent).toContain('Transformers');
    expect(drawer?.textContent).toContain('Architecture');
    // renderMarkdown converts **bold** → <strong>bold</strong>.
    expect(drawer?.querySelector('.chunk strong')?.textContent).toBe(
      'self-attention'
    );
  });

  it('omits the heading crumbs row when headingPath is empty', () => {
    const { container } = render(
      <SourceDrawer
        source={makeSource({ headingPath: [] })}
        onClose={() => {}}
      />
    );
    expect(container.querySelector('.source-drawer .crumbs')).toBeNull();
  });

  it('shows the score formatted to 3 decimal places', () => {
    const { container } = render(
      <SourceDrawer source={makeSource({ score: 0.5 })} onClose={() => {}} />
    );
    expect(container.querySelector('.source-drawer .score')?.textContent).toBe(
      'score 0.500'
    );
  });

  it('points the "Open file" link at /api/download/<encoded filePath>', () => {
    const { container } = render(
      <SourceDrawer
        source={makeSource({ filePath: 'with spaces & weird.pdf' })}
        onClose={() => {}}
      />
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
    const { container } = render(
      <SourceDrawer source={makeSource({ filePath: '' })} onClose={() => {}} />
    );
    expect(container.querySelector('.source-drawer .open-file')).toBeNull();
  });

  it('closes on × button click', () => {
    const onClose = vi.fn();
    const { container } = render(
      <SourceDrawer source={makeSource()} onClose={onClose} />
    );
    fireEvent.click(container.querySelector('.close-x') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    const { container } = render(
      <SourceDrawer source={makeSource()} onClose={onClose} />
    );
    fireEvent.click(container.querySelector('.drawer-backdrop') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on ESC keydown', () => {
    const onClose = vi.fn();
    render(<SourceDrawer source={makeSource()} onClose={onClose} />);
    // happy-dom doesn't dispatch `fireEvent.keyDown(window, ...)` to
    // the global listener, so dispatch the event directly on `window`.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not register an ESC listener when source is null', () => {
    const onClose = vi.fn();
    render(<SourceDrawer source={null} onClose={onClose} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores non-Escape keydown events', () => {
    const onClose = vi.fn();
    render(<SourceDrawer source={makeSource()} onClose={onClose} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes the ESC listener when the drawer unmounts', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <SourceDrawer source={makeSource()} onClose={onClose} />
    );
    unmount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});