import { useEffect, useRef, useState } from 'preact/hooks';
import { Dropzone } from '../components/Dropzone';
import {
  QueueRow,
  extFromName,
  fmtSize,
  type QueueRowData,
} from '../components/QueueRow';
import { DocumentsList } from '../components/DocumentsList';
import { uploadFile } from '../services/upload';
import { fetchStatus } from '../services/status';
import {
  listDocuments,
  deleteDocument,
  type Document,
} from '../services/documents';

// Upload route — page head + dropzone + queue. p2-T15 wires Dropzone to
// POST /api/upload via XHR so transport progress drives the queue
// rows directly (see services/upload.ts for the design rationale).
//
// Concurrency: bounded ≤4 in flight at once. Each new file from the
// dropzone joins the queue; an idle worker pool pulls up to 4 at a
// time. Cancel: the row's "×" button aborts the XHR (closes the
// socket, halts the bytes) and removes the row.

const MAX_CONCURRENCY = 4;

interface InFlightUpload {
  id: string;
  abort: () => void;
}

export function Upload() {
  const [rows, setRows] = useState<QueueRowData[]>([]);
  const [chunksIndexed, setChunksIndexed] = useState<number | null>(null);

  // Phase 03 / p3-T03: Documents list state. Loaded once on
  // mount, refreshed after each upload completes, refreshed after
  // each successful delete. The list is the source of truth for
  // what's indexed — we don't fold rows into it; the queue is
  // short-lived (one-shot upload flow) and the documents list is
  // persistent.
  const [documents, setDocuments] = useState<Document[]>([]);
  const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined);
  const [documentsVersion, bumpDocumentsVersion] = useState(0);

  // Track in-flight uploads by id so the "×" button can abort them.
  // ref (not state) because mutating the handle's abort fn doesn't
  // need a re-render.
  const inflightRef = useRef<Map<string, InFlightUpload>>(new Map());

  // Read /api/status for the "N chunks indexed" badge in the header.
  // Same 5s poll pattern App.tsx uses; Upload isn't part of the App
  // chrome so it manages its own subscription.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await fetchStatus();
        if (!cancelled) setChunksIndexed(s.chunks);
      } catch {
        /* network blip — keep last value */
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, 5_000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      // Cancel any uploads still in flight when the page unmounts.
      for (const h of inflightRef.current.values()) h.abort();
      inflightRef.current.clear();
    };
  }, []);

  // Phase 03 / p3-T03: load the documents list. Refreshed by
  // bumping `documentsVersion` (after upload completion, after
  // delete). No continuous polling — the list is otherwise static
  // during a page session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const docs = await listDocuments();
        if (!cancelled) setDocuments(docs);
      } catch {
        /* network blip — keep last value */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentsVersion]);

  function remove(id: string) {
    const handle = inflightRef.current.get(id);
    if (handle) {
      handle.abort();
      inflightRef.current.delete(id);
    }
    setRows((r) => r.filter((x) => x.id !== id));
  }

  function updateRow(id: string, patch: Partial<QueueRowData>) {
    setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  function enqueue(files: File[]) {
    // Append new rows for each file, then start uploading with bounded
    // concurrency. New rows are immediately visible (status: uploading,
    // progress: 0).
    const newRows: QueueRowData[] = files.map((file) => ({
      id: crypto.randomUUID(),
      fileName: file.name,
      ext: extFromName(file.name),
      size: fmtSize(file.size),
      chunks: 0,
      status: 'uploading',
      progress: 0,
    }));
    setRows((r) => [...newRows, ...r]);

    // Worker pool: up to MAX_CONCURRENCY in flight; each worker
    // grabs the next pending row and processes it.
    const ac = new AbortController();
    const queue = [...newRows];

    const worker = async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) break;
        const file = files.find((f) => f.name === row.fileName);
        if (!file) continue;

        const handle = uploadFile(
          file,
          (loaded, total) => {
            const pct = Math.floor((loaded / total) * 100);
            updateRow(row.id, { progress: pct });
          },
          ac.signal
        );
        inflightRef.current.set(row.id, handle);

        try {
          const result = await handle.promise;
          if (result.success) {
            updateRow(row.id, {
              status: 'ready',
              progress: 100,
              chunks: result.chunksIndexed ?? 0,
            });
            // Phase 03 / p3-T03: refresh the documents list so the
            // new row shows up below the queue.
            bumpDocumentsVersion((v) => v + 1);
          } else {
            updateRow(row.id, {
              status: 'failed',
              error: result.error ?? 'Upload failed',
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === 'aborted') {
            // Row was removed by the user — drop the aborted state.
            setRows((r) => r.filter((x) => x.id !== row.id));
          } else {
            updateRow(row.id, {
              status: 'failed',
              error: msg,
            });
          }
        } finally {
          inflightRef.current.delete(row.id);
        }
      }
    };

    const workerCount = Math.min(MAX_CONCURRENCY, newRows.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    void Promise.all(workers);

    // The ac is intentionally unused after the queue is drained.
    // Cancelling mid-flight happens per-row via the row's abort()
    // handle, which calls xhr.abort() directly. This ac is here so
    // a future "cancel all" UI hook has something to wire to.
    void ac;
  }

  async function handleDelete(fileId: string): Promise<void> {
    setPendingDelete(fileId);
    try {
      await deleteDocument(fileId);
      // Refresh both the documents list and the status (chunks count
      // will drop on the next 5s poll; explicit refresh here makes
      // the delete feel instant).
      bumpDocumentsVersion((v) => v + 1);
    } finally {
      setPendingDelete(undefined);
    }
  }

  return (
    <div class="upload-page">
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
            <b>{chunksIndexed === null ? '—' : chunksIndexed.toLocaleString()}</b>
            chunks indexed
          </div>
        </div>

        <Dropzone onFiles={enqueue} />

        <div class="section">
          <h3>
            Queue <span class="count">{rows.length}</span>
          </h3>
          <div class="queue">
            {rows.map((row) => (
              <QueueRow key={row.id} row={row} onRemove={remove} />
            ))}
            {rows.length === 0 && (
              <div class="queue-empty">
                Drop a file above to start indexing.
              </div>
            )}
          </div>
        </div>

        <div class="section">
          <h3>
            Documents <span class="count">{documents.length}</span>
          </h3>
          <DocumentsList
            documents={documents}
            onDelete={handleDelete}
            pendingFileId={pendingDelete}
          />
        </div>
      </div>
    </div>
  );
}