// Typed fetch wrappers for /api/auth/* (p4-T16). All mutating calls
// send `credentials: 'include'` so the HttpOnly `dockhoj_sid` cookie
// flows to/from the Fastify server. fetchMe() returns null on 401
// instead of throwing — useAuth() polls it on every mount and treats
// 401 as "anonymous".

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    /* body wasn't JSON */
  }
  return `HTTP ${res.status} ${res.statusText}`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return (await res.json()) as T;
}

// GET /api/auth/me — FR-7. Returns null on 401 so useAuth() can flip
// to 'anonymous' without a try/catch at the call site.
export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AuthUser;
}

// POST /api/auth/login — FR-4/5.
export async function login(username: string, password: string): Promise<AuthUser> {
  return postJson<AuthUser>('/api/auth/login', { username, password });
}

// POST /api/auth/logout — FR-6. Idempotent; server clears the cookie.
export async function logout(): Promise<void> {
  const res = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(await readError(res));
}

// POST /api/auth/register — FR-1. First user only.
export async function register(username: string, password: string): Promise<AuthUser> {
  return postJson<AuthUser>('/api/auth/register', { username, password });
}

// POST /api/auth/invite/accept — FR-13/14.
export async function acceptInvite(args: {
  token: string;
  username: string;
  password: string;
}): Promise<AuthUser> {
  return postJson<AuthUser>('/api/auth/invite/accept', args);
}

// GET /api/auth/status — public. The SPA's Register page uses this
// to decide whether to render the form or hide it.
export async function fetchAuthStatus(): Promise<{ firstUserAvailable: boolean }> {
  const res = await fetch('/api/auth/status');
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { firstUserAvailable: boolean };
}

// p4-T19 — admin service calls. Kept inside auth.ts (one service
// file per route family, matching how documents.ts / sessions.ts
// are split). Each call sends credentials: 'include' (HttpOnly
// cookie). `createInvite` returns the one-time token; the others
// throw on non-2xx (the SPA components handle that).

export interface AdminUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AdminInvite {
  id: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedBy: string | null;
  usedAt: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

async function delOrThrow(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) throw new Error(await readError(res));
}

// GET /api/admin/users — FR-15.
export async function listUsers(): Promise<AdminUser[]> {
  return getJson<AdminUser[]>('/api/admin/users');
}

// DELETE /api/admin/users/:id — FR-16. 400 if the target is the
// caller; the SPA disables the button, but the server enforces.
export async function deleteUser(id: string): Promise<{ success: true; documentsDeleted: number }> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

// POST /api/admin/users/:id/password — FR-17. Also revokes all of
// that user's sessions (the user must re-login on next request).
export async function resetPassword(id: string, password: string): Promise<{ success: true }> {
  return postJson<{ success: true }>(`/api/admin/users/${encodeURIComponent(id)}/password`, {
    password,
  });
}

// GET /api/admin/invites — FR-11. Excludes the raw token (only the
// hash is stored; the token is shown ONCE on creation).
export async function listInvites(): Promise<AdminInvite[]> {
  return getJson<AdminInvite[]>('/api/admin/invites');
}

// POST /api/admin/invites — FR-10. Returns the one-time raw token.
export async function createInvite(expiresInDays = 7): Promise<{
  id: string;
  token: string;
  expiresAt: string;
}> {
  return postJson('/api/admin/invites', { expiresInDays });
}

// DELETE /api/admin/invites/:id — FR-12. 404 if no such invite.
export async function revokeInvite(id: string): Promise<void> {
  await delOrThrow(`/api/admin/invites/${encodeURIComponent(id)}`);
}