import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useAuth } from '../hooks/useAuth';
import {
  listUsers,
  deleteUser,
  resetPassword,
  type AdminUser,
} from '../services/auth';

// AdminUsers — /admin/users. Lists users with role badges, reset-
// password modal, and a delete-with-confirm. Self-delete is
// disabled both client-side (u.id === currentUser.id) and server-
// side (api-admin returns 400; SPA shows the server error verbatim
// so the discrepancy is debuggable).
//
// ponytail: native <table> + radio inputs + a tiny inline modal —
// no UI library, no new abstraction.

export function AdminUsers() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await listUsers();
      setUsers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return (
      <div class="admin-page">
        <div class="admin-shell">
          <div class="admin-error">{error}</div>
        </div>
      </div>
    );
  }

  if (users === null) {
    return (
      <div class="admin-page">
        <div class="admin-shell">
          <div class="documents-empty">Loading users…</div>
        </div>
      </div>
    );
  }

  return (
    <div class="admin-page">
      <div class="admin-shell">
        <div class="page-head">
          <div class="l">
            <div class="eyebrow">Admin · Users</div>
            <h1>
              The <i>team</i>.
            </h1>
            <p>Manage who's on the server. Reset a password, revoke access, or audit roles.</p>
          </div>
          <div class="r">
            <b>{users.length}</b>
            {users.length === 1 ? 'user' : 'users'}
          </div>
        </div>

        <div class="section">
          <div class="users-table-wrap">
            <table class="users-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Last login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = currentUser?.id === u.id;
                  return (
                    <UserRow
                      key={u.id}
                      user={u}
                      isSelf={isSelf}
                      onChanged={reload}
                      onError={setError}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  user: AdminUser;
  isSelf: boolean;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}

function UserRow({ user, isSelf, onChanged, onError }: RowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busyDelete, setBusyDelete] = useState(false);
  const [showReset, setShowReset] = useState(false);

  async function doDelete() {
    if (isSelf) return;
    setBusyDelete(true);
    setConfirmingDelete(false);
    try {
      await deleteUser(user.id);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyDelete(false);
    }
  }

  return (
    <tr>
      <td>
        <div class="users-table-name">
          <span>{user.username}</span>
          {isSelf && <span class="users-table-self" title="You">you</span>}
        </div>
      </td>
      <td>
        <span class={`role-badge role-${user.role}`}>{user.role}</span>
      </td>
      <td class="users-table-sub">{user.lastLoginAt ? fmtRelative(user.lastLoginAt) : 'never'}</td>
      <td>
        <div class="users-table-actions">
          <button
            type="button"
            class="doc-action"
            onClick={() => setShowReset(true)}
          >
            Reset password
          </button>
          {confirmingDelete ? (
            <button
              type="button"
              class="doc-action danger confirm"
              disabled={busyDelete}
              onClick={doDelete}
            >
              {busyDelete ? '…' : 'click to confirm'}
            </button>
          ) : (
            <button
              type="button"
              class="doc-action danger"
              disabled={isSelf || busyDelete}
              title={isSelf ? 'You cannot delete your own account' : undefined}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </button>
          )}
        </div>
        {showReset && (
          <ResetPasswordModal
            username={user.username}
            onCancel={() => setShowReset(false)}
            onDone={async () => {
              setShowReset(false);
              await onChanged();
            }}
            onError={onError}
            submit={async (password) => {
              await resetPassword(user.id, password);
            }}
          />
        )}
      </td>
    </tr>
  );
}

interface ResetModalProps {
  username: string;
  submit: (password: string) => Promise<unknown>;
  onCancel: () => void;
  onDone: () => Promise<void>;
  onError: (msg: string) => void;
}

function ResetPasswordModal({ username, submit, onCancel, onDone, onError }: ResetModalProps) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC + backdrop click close the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    // Focus the password input on open so the user can type right away.
    const t = window.setTimeout(() => {
      const i = dialogRef.current?.querySelector<HTMLInputElement>('input[type="password"]');
      i?.focus();
    }, 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [onCancel]);

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await submit(password);
      await onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Reset failed');
      setBusy(false);
    }
  }

  return (
    <div class="modal-overlay" onClick={onCancel} role="presentation">
      <div
        class="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Reset password for ${username}`}
        ref={dialogRef}
      >
        <div class="modal-eyebrow">Reset password</div>
        <h2 class="modal-title">{username}</h2>
        <p class="modal-sub">
          Set a new password. The user will be signed out across every active session.
        </p>
        <form onSubmit={onSubmit}>
          <label class="auth-card-label">
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
            <span class="auth-hint">At least 12 characters, including one symbol.</span>
          </label>
          <div class="modal-actions">
            <button type="button" class="doc-action" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" class="doc-action primary" disabled={busy || password.length < 12}>
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Mirror DocumentsList.fmtRelative — extract only the token-class
// helper for the table. SQLite timestamps are UTC by construction.
function fmtRelative(s: string): string {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return s;
  const y = +m[1]!;
  const mo = +m[2]!;
  const d = +m[3]!;
  const h = +m[4]!;
  const mi = +m[5]!;
  const se = +m[6]!;
  const then = Date.UTC(y, mo - 1, d, h, mi, se);
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
