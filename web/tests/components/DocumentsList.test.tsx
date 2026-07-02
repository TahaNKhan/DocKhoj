import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/preact';
import { DocumentsList } from '../../src/components/DocumentsList';
import type { Document } from '../../src/services/documents';

// p3-T03 — DocumentsList component. Covers:
//   1. Empty state renders the placeholder.
//   2. Renders one row per document with file name + chunk count.
//   3. First click arms the confirm; second click within the
//      window commits the delete.
//   4. Confirm state expires after 5s.
//   5. onDelete rejection shows the error pill; dismiss clears it.

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    fileId: 'file-1',
    fileName: 'notes.md',
    fileType: 'md',
    bytes: 2048,
    uploadedAt: '2026-07-01 10:00:00',
    chunkCount: 12,
    ...overrides,
  };
}

describe('DocumentsList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders an empty-state placeholder when there are no documents', () => {
    const { container } = render(
      <DocumentsList documents={[]} onDelete={async () => {}} />
    );
    expect(container.querySelector('.documents-empty')).not.toBeNull();
    expect(container.querySelector('.docrow')).toBeNull();
  });

  it('renders one row per document with name + chunk count', () => {
    const docs = [
      makeDoc({ fileId: 'a', fileName: 'first.md', chunkCount: 4 }),
      makeDoc({ fileId: 'b', fileName: 'second.pdf', fileType: 'pdf', chunkCount: 17 }),
    ];
    const { container } = render(
      <DocumentsList documents={docs} onDelete={async () => {}} />
    );
    const rows = container.querySelectorAll('.docrow');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('first.md');
    expect(rows[0]!.textContent).toContain('4 chunks');
    expect(rows[1]!.textContent).toContain('second.pdf');
    expect(rows[1]!.textContent).toContain('17 chunks');
    expect(rows[1]!.textContent).toContain('PDF');
  });

  it('first click arms confirm; second click commits delete', async () => {
    const onDelete = vi.fn(async () => {});
    const { container } = render(
      <DocumentsList documents={[makeDoc()]} onDelete={onDelete} />
    );
    const delBtn = container.querySelector('.docrow button.del') as HTMLButtonElement;
    expect(delBtn.textContent).toContain('delete');

    // First click — arms the confirm.
    await act(async () => {
      fireEvent.click(delBtn);
    });
    const confirmBtn = container.querySelector('.docrow.confirming button.del-confirm');
    expect(confirmBtn).not.toBeNull();
    expect(confirmBtn!.textContent).toContain('click again to confirm');

    // Second click — commits.
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('file-1');
  });

  it('confirm state expires after 5 seconds', async () => {
    const onDelete = vi.fn(async () => {});
    const { container } = render(
      <DocumentsList documents={[makeDoc()]} onDelete={onDelete} />
    );
    const delBtn = container.querySelector('.docrow button.del') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(delBtn);
    });
    expect(container.querySelector('.docrow.confirming')).not.toBeNull();

    // Advance past the confirm window.
    await act(async () => {
      vi.advanceTimersByTime(5_100);
    });
    expect(container.querySelector('.docrow.confirming')).toBeNull();
    expect(container.querySelector('.docrow button.del')).not.toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('onDelete rejection shows the error pill; click dismisses it', async () => {
    const onDelete = vi.fn(async () => {
      throw new Error('boom');
    });
    const { container } = render(
      <DocumentsList documents={[makeDoc()]} onDelete={onDelete} />
    );
    const delBtn = container.querySelector('.docrow button.del') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(delBtn);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('.docrow.confirming button.del-confirm')!);
    });
    expect(onDelete).toHaveBeenCalledTimes(1);

    const errBtn = container.querySelector('.docrow.errored button.del-err') as HTMLButtonElement;
    expect(errBtn).not.toBeNull();
    expect(errBtn.textContent).toContain('failed');

    await act(async () => {
      fireEvent.click(errBtn);
    });
    expect(container.querySelector('.docrow.errored')).toBeNull();
  });

  it('disables the delete button while pendingFileId matches', () => {
    const { container } = render(
      <DocumentsList documents={[makeDoc()]} onDelete={async () => {}} pendingFileId="file-1" />
    );
    const delBtn = container.querySelector('.docrow button.del') as HTMLButtonElement;
    expect(delBtn.disabled).toBe(true);
  });
});