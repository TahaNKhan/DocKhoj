// upload.ts — POST /api/upload with XHR-based transport progress.
//
// Why XHR instead of fetch: the browser's `fetch` API does NOT expose
// transport progress (the bytes flowing from client to server). The
// browser's `XMLHttpRequest.upload.onprogress` event DOES — that's
// the only built-in way to drive a progress bar from 0..100% during
// the file transfer. The server-side index time (parse + embed +
// upsert) is hidden behind the same POST and reported in the
// response, so the SPA's queue row transitions through three states:
//
//   uploading  → progress = bytes-loaded / total-bytes * 100
//   indexing   → indeterminate (POST in flight after upload)
//   ready      → response succeeded, chunksIndexed known
//   failed     → response was 4xx/5xx or network error
//
// AbortSignal integration: passing a signal wires it into the XHR's
// `abort()` so the caller can cancel in-flight uploads. Without a
// signal, callers can still cancel via the returned { abort() }.

export interface UploadResult {
  success: boolean;
  fileName: string;
  chunksIndexed?: number;
  fileId?: string;
  error?: string;
}

export type UploadProgress = (loaded: number, total: number) => void;

export interface UploadHandle {
  promise: Promise<UploadResult>;
  abort: () => void;
}

const XHR_EVENTS = ['load', 'error', 'abort'] as const;
type XhrEvent = (typeof XHR_EVENTS)[number];

interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  upload: { addEventListener(name: 'progress', fn: (e: ProgressEvent) => void): void };
  addEventListener(name: XhrEvent, fn: () => void): void;
  send(body: BodyInit): void;
  abort(): void;
  status: number;
  responseText: string;
  withCredentials: boolean;
}

export function uploadFile(
  file: File,
  onProgress?: UploadProgress,
  signal?: AbortSignal,
  visibility?: 'public' | 'private'
): UploadHandle {
  const xhr = new XMLHttpRequest() as unknown as XhrLike;
  xhr.open('POST', '/api/upload');
  xhr.withCredentials = false;

  let aborted = false;

  // XHR's `upload.onprogress` is the only way the browser exposes
  // transport-progress events. `e.lengthComputable` is false for some
  // edge cases (multipart bodies with unknown total length) — in
  // those cases we just skip the tick rather than divide by zero.
  xhr.upload.addEventListener('progress', (e: ProgressEvent) => {
    if (!onProgress) return;
    if (!e.lengthComputable || e.total <= 0) return;
    onProgress(e.loaded, e.total);
  });

  const promise = new Promise<UploadResult>((resolve, reject) => {
    const onAbort = () => {
      aborted = true;
      try {
        xhr.abort();
      } catch {
        /* already aborted */
      }
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    xhr.addEventListener('load', () => {
      if (aborted) {
        reject(new Error('aborted'));
        return;
      }
      // 2xx → parse JSON; 4xx/5xx → surface server's error field if any.
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as UploadResult;
          resolve(body);
        } catch (err) {
          reject(new Error(`Invalid response: ${err instanceof Error ? err.message : String(err)}`));
        }
      } else {
        let detail = `HTTP ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          /* not JSON — use the status code message */
        }
        reject(new Error(detail));
      }
    });

    xhr.addEventListener('error', () => {
      if (aborted) {
        reject(new Error('aborted'));
        return;
      }
      reject(new Error('Network error'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });

    const form = new FormData();
    form.append('file', file);
    // p4-T18: thread visibility to the server. Server defaults to
    // 'private' when omitted, but we send it explicitly so the user
    // sees their selection take effect immediately on the next list
    // refresh (no extra round trip).
    if (visibility) form.append('visibility', visibility);
    xhr.send(form);
  });

  return {
    promise,
    abort: () => {
      try {
        xhr.abort();
      } catch {
        /* already aborted */
      }
    },
  };
}