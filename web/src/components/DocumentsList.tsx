import { useEffect, useState } from 'preact/hooks';
import type { Document } from '../services/documents';

// DocumentsList — Phase 03 / p3-T03. Renders the user's indexed
// documents below the upload queue on /upload. Each row exposes a
// destructive delete action that uses an inline-confirm pattern (a
// second click within 5s commits the delete). On confirm, the row
// is removed optimistically; on a server error the row reappears
// with an inline error pill that the user can dismiss.
//
// Concurrency model: deletion is per-row; the parent (Upload.tsx)
// owns the list state and orchestrates a refresh after each
// upload. This component does not poll — it re-renders when its
// `documents` prop changes.

export interface DocumentsListProps {
  documents: Document[];
  onDelete: (fileId: string) => Promise<unknown>;
  pendingFileId?: string;
}

const CONFIRM_WINDOW_MS = 5000;

interface ConfirmState {
  fileId: string;
  expiresAt: number;
}

export function DocumentsList({ documents, onDelete, pendingFileId }: DocumentsListProps) {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [errorFileId, setErrorFileId] = useState<string | null>(null);

  // 5-second confirm window: the second click must happen before
  // `expiresAt`. The cleanup clears the timer when the user
  // cancels (clicks elsewhere, clicks again later, deletes
  // something else).
  useEffect(() => {
    if (!confirm) return;
    const remaining = confirm.expiresAt - Date.now();
    if (remaining <= 0) {
      setConfirm(null);
      return;
    }
    const t = window.setTimeout(() => setConfirm(null), remaining);
    return () => window.clearTimeout(t);
  }, [confirm]);

  if (documents.length === 0) {
    return (
      <div class="documents-empty">
        No documents indexed yet. Drop a file above and it will appear here once it has
        been chunked.
      </div>
    );
  }

  function clickRow(doc: Document) {
    setErrorFileId(null);
    if (confirm && confirm.fileId === doc.fileId) {
      // Second click within the window: commit the delete.
      setConfirm(null);
      void onDelete(doc.fileId).catch(() => setErrorFileId(doc.fileId));
    } else {
      setConfirm({ fileId: doc.fileId, expiresAt: Date.now() + CONFIRM_WINDOW_MS });
    }
  }

  return (
    <div class="documents-list">
      <ul>
        {documents.map((doc) => {
          const isConfirming = confirm?.fileId === doc.fileId;
          const isPending = pendingFileId === doc.fileId;
          const hasError = errorFileId === doc.fileId;
          return (
            <DocumentRow
              key={doc.fileId}
              doc={doc}
              isConfirming={isConfirming}
              isPending={isPending}
              hasError={hasError}
              onClick={() => clickRow(doc)}
              onDismissError={() => setErrorFileId(null)}
            />
          );
        })}
      </ul>
    </div>
  );
}

interface RowProps {
  doc: Document;
  isConfirming: boolean;
  isPending: boolean;
  hasError: boolean;
  onClick: () => void;
  onDismissError: () => void;
}

function DocumentRow({
  doc,
  isConfirming,
  isPending,
  hasError,
  onClick,
  onDismissError,
}: RowProps) {
  const size = fmtSize(doc.bytes);
  const uploadedLabel = fmtRelative(doc.uploadedAt);
  const extLabel = (doc.fileType || 'file').toUpperCase().slice(0, 4);

  return (
    <li class={`docrow${isConfirming ? ' confirming' : ''}${hasError ? ' errored' : ''}`}>
      <div class="ext">{extLabel}</div>
      <div class="meta">
        <div class="name">{doc.fileName}</div>
        <div class="sub">
          {size}
          {doc.chunkCount > 0 && <> · ~{doc.chunkCount} chunks</>}
          <> · {uploadedLabel}</>
        </div>
      </div>
      <div class="actions">
        {hasError ? (
          <button class="del-err" onClick={onDismissError} title="Dismiss error">
            failed — dismiss
          </button>
        ) : (
          <button
            class={isConfirming ? 'del-confirm' : 'del'}
            disabled={isPending}
            onClick={onClick}
          >
            {isPending ? '…' : isConfirming ? 'click again to confirm' : 'delete'}
          </button>
        )}
      </div>
    </li>
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a SQLite `YYYY-MM-DD HH:MM:SS` timestamp (UTC) as a
 *  relative-time string ("just now", "5m ago", "2h ago", "3d
 *  ago", or a short absolute date for older items). */
function fmtRelative(s: string): string {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return s;
  const y = m[1]!;
  const mo = m[2]!;
  const d = m[3]!;
  const h = m[4]!;
  const mi = m[5]!;
  const se = m[6]!;
  // SQLite's "YYYY-MM-DD HH:MM:SS" is UTC by construction
  // (datetime('now') returns UTC).
  const then = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${y}-${mo}-${d}`;
}