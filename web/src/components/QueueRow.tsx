// QueueRow — one file in the upload queue. p2-T15 drives progress via
// XHR's `upload.onprogress` (transport) + the POST response (final).
//
// Status transitions during a single upload:
//   uploading  (transport in flight)   → progress = bytes/total * 100
//   indexing   (POST in flight, post-upload) → indeterminate
//   ready      (server returned success)
//   failed     (server returned error or network failure)
//
// `progress` is 0..100 once we have a number to show. During the
// indexing phase we render the bar at the last transport percentage
// (typically 100) with a pulsing animation to signal "still working"
// — same visual idiom the mockup uses.

export interface QueueRowData {
  id: string;
  fileName: string;
  ext: string; // 2-3 char display label, e.g. "PDF"
  size: string;
  chunks: number;
  status: 'uploading' | 'indexing' | 'ready' | 'failed';
  progress: number; // 0..100
  error?: string;
}

interface Props {
  row: QueueRowData;
  onRemove?: (id: string) => void;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extFromName(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0 || i === name.length - 1) return 'FILE';
  const ext = name.slice(i + 1).toUpperCase();
  return ext.length > 4 ? ext.slice(0, 4) : ext;
}

export { fmtSize, extFromName };

export function QueueRow({ row, onRemove }: Props) {
  const pct = Math.max(0, Math.min(100, Math.floor(row.progress)));
  const isDone = row.status === 'ready';
  const isIndexing = row.status === 'indexing';
  const isFailed = row.status === 'failed';

  return (
    <div
      class={`qrow${isDone ? ' done' : ''}${isFailed ? ' failed' : ''}${isIndexing ? ' indexing' : ''}`}
    >
      <div class="file">{row.ext}</div>
      <div class="name">
        {row.fileName}
        <small>
          {row.size}
          {row.status === 'ready' && row.chunks > 0 && <> · ~{row.chunks} chunks</>}
          {isFailed && row.error && <> · {row.error}</>}
        </small>
      </div>
      <div class="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div class="pct">{isIndexing ? '…' : `${pct}%`}</div>
      <div class="status">
        <span class="pulse-dot" />
        {row.status}
      </div>
      <button
        class="x"
        aria-label="remove"
        onClick={() => onRemove?.(row.id)}
      >
        ×
      </button>
    </div>
  );
}