import { useState } from 'preact/hooks';
import { Dropzone } from '../components/Dropzone';
import { QueueRow, type QueueRowData } from '../components/QueueRow';

// Upload route — page head + dropzone + queue. T25 ships three static
// rows; T36 wires to live SSE progress. The right-aligned chunk count is
// a placeholder until T35 (/api/status) lands.

const SEED_ROWS: QueueRowData[] = [
  {
    id: 'r1',
    fileName: 'attention-is-all-you-need.pdf',
    ext: 'PDF',
    size: '2.1 MB',
    chunks: 412,
    status: 'ready',
    progress: 100,
  },
  {
    id: 'r2',
    fileName: 'notes-on-habit-loops.md',
    ext: 'MD',
    size: '18 KB',
    chunks: 46,
    status: 'ready',
    progress: 100,
  },
  {
    id: 'r3',
    fileName: 'garden-logbook-spring.txt',
    ext: 'TXT',
    size: '92 KB',
    chunks: 88,
    status: 'ready',
    progress: 100,
  },
];

export function Upload() {
  const [rows, setRows] = useState<QueueRowData[]>(SEED_ROWS);

  function remove(id: string) {
    setRows((r) => r.filter((x) => x.id !== id));
  }

  return (
    <div class="upload-shell">
      <div class="page-head">
        <div class="l">
          <div class="eyebrow">Ingest</div>
          <h1>
            Drop it in.
            <br />
            We'll <i>read</i> it for you.
          </h1>
          <p>
            Drag a file, paste a URL, or point us at a folder. DocKhoj chunks,
            embeds, and indexes — quietly, in the background.
          </p>
        </div>
        <div class="r">
          <b>2,847</b>
          chunks indexed
        </div>
      </div>

      <Dropzone
        onFiles={(files) => {
          /* T36 wires to POST /api/upload + GET /api/upload/progress */
          console.log(
            'dropped files (stub):',
            files.map((f) => f.name)
          );
        }}
      />

      <div class="section">
        <h3>
          Queue <span class="count">{rows.length}</span>
        </h3>
        <div class="queue">
          {rows.map((row) => (
            <QueueRow key={row.id} row={row} onRemove={remove} />
          ))}
        </div>
      </div>
    </div>
  );
}