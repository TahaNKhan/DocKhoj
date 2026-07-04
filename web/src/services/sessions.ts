// Typed fetch wrappers for /api/sessions. The SPA doesn't talk to the
// network directly anywhere else — these are the only HTTP callers.

// Mirror the server's TypeScript types so the SPA and the server
// agree on shape. If these drift, the integration tests in p2-T20 will
// catch it.

export interface Conversation {
  id: string;
  title: string;
  titleSource: 'default' | 'generated' | 'fallback' | 'user';
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

// Phase 03 / p3-T09: re-export ToolCallRecord from the shared types
// file so consumers can import from either path without breakage.
export type { ToolCallRecord } from '../types';
import type { ToolCallRecord } from '../types';

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Array<{
    fileName: string;
    filePath: string;
    chunk: string;
    pageNumber?: number;
    headingPath?: string[];
    score: number;
  }>;
  toolCalls?: ToolCallRecord[];
  createdAt: string;
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

export async function listSessions(): Promise<Conversation[]> {
  const res = await fetch('/api/sessions');
  const body = await jsonOrThrow<{ sessions: Conversation[] }>(res);
  return body.sessions;
}

export async function getSession(id: string): Promise<Conversation> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  return jsonOrThrow<Conversation>(res);
}

export async function createSession(): Promise<Conversation> {
  const res = await fetch('/api/sessions', { method: 'POST' });
  return jsonOrThrow<Conversation>(res);
}

export async function renameSession(id: string, title: string): Promise<Conversation> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return jsonOrThrow<Conversation>(res);
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    await jsonOrThrow(res);
  }
}

export async function listMessages(id: string): Promise<Message[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`);
  const body = await jsonOrThrow<{ messages: Message[] }>(res);
  return body.messages;
}

// localStorage helpers — single source of truth for which session is
// currently active across reloads.

const ACTIVE_KEY = 'dockhoj.activeSession';

export function loadActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveSessionId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* private mode or storage disabled — best-effort */
  }
}

export function clearActiveSessionId(): void {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* noop */
  }
}

// Pinned sessions — stored as a sorted JSON array of session IDs in
// localStorage. The caller decides sort order; the storage layer just
// persists the set.

const PINNED_KEY = 'dockhoj.pinned';

export function getPinnedIds(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function savePinnedIds(ids: string[]): void {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    /* best-effort */
  }
}

export function togglePinnedId(id: string): boolean {
  const ids = getPinnedIds();
  const idx = ids.indexOf(id);
  if (idx !== -1) {
    ids.splice(idx, 1);
    savePinnedIds(ids);
    return false; // no longer pinned
  }
  ids.unshift(id);
  savePinnedIds(ids);
  return true; // now pinned
}