// QueueRow — one file in the upload queue. T25 ships three static
// rows (matches the mockup seed). T36 drives progress via SSE.

export interface QueueRowData {
  id: string;
  fileName: string;
  ext: string; // 2-3 char display label, e.g. "PDF"
  size: string;
  chunks: number;
  status: 'queued' | 'embedding' | 'ready' | 'failed';
  progress: number; // 0..100
}

interface Props {
  row: QueueRowData;
  onRemove?: (id: string) => void;
}

export function QueueRow({ row, onRemove }: Props) {
  const pct = Math.max(0, Math.min(100, Math.floor(row.progress)));
  const isDone = row.status === 'ready';

  return (
    <div class={`qrow${isDone ? ' done' : ''}`}>
      <div class="file">{row.ext}</div>
      <div class="name">
        {row.fileName}
        <small>
          {row.size} · ~{row.chunks} chunks
        </small>
      </div>
      <div class="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div class="pct">{pct}%</div>
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
