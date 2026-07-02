// Typed fetch wrappers for /api/documents — Phase 03 / p3-T03.
// Mirrors the server's DocumentRow shape (services/document-store.ts
// on the server side). The Document type below MUST stay in sync
// with the server's response; the integration smoke test catches
// drift.

export interface Document {
  fileId: string;
  fileName: string;
  fileType: string;
  bytes: number;
  uploadedAt: string;
  chunkCount: number;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail ?? `HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function listDocuments(): Promise<Document[]> {
  const res = await fetch('/api/documents');
  const body = await jsonOrThrow<{ documents: Document[] }>(res);
  return body.documents ?? [];
}

export interface DeleteDocumentResult {
  success: true;
  chunksDeleted: number;
  fileId: string;
}

/**
 * Delete a document by fileId. Returns `{ success: true, ... }` on
 * 200, throws on 500. A 404 (already gone) is treated as success —
 * the SPA can refresh its list after the call, so a row that
 * vanished between read and delete is not a user-visible error.
 */
export async function deleteDocument(fileId: string): Promise<DeleteDocumentResult | 'gone'> {
  const res = await fetch(`/api/documents/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  });
  if (res.status === 404) return 'gone';
  return jsonOrThrow<DeleteDocumentResult>(res);
}