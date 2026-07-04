import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  listInvites,
  createInvite,
  revokeInvite,
  type AdminInvite,
} from '../services/auth';

// AdminInvites — /admin/invites. Lists outstanding invites (no raw
// token), creates new ones with a copyable one-time token banner,
// and revokes outstanding entries.
//
// ponytail: native form + native clipboard.writeText — no UI lib.

export function AdminInvites() {
  const [invites, setInvites] = useState<AdminInvite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expiryDays, setExpiryDays] = useState(7);
  const [revokingId, setRevokingId] = useState<string | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      const list = await listInvites();
      setInvites(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invites');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onCreate(e: Event) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createInvite(expiryDays);
      setNewToken({ token: result.token, expiresAt: result.expiresAt });
      setCopied(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invite');
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    if (revokingId) return;
    setRevokingId(id);
    setError(null);
    try {
      await revokeInvite(id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke invite');
    } finally {
      setRevokingId(undefined);
    }
  }

  function dismissBanner() {
    // Once dismissed, the token is gone — re-fetching the list never
    // returns the raw token (it lives only in `newToken`).
    setNewToken(null);
    setCopied(false);
  }

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Clipboard write blocked (e.g., insecure context). Leave the
      // banner visible — user can select-and-copy manually.
    }
  }

  if (error && invites === null) {
    return (
      <div class="admin-page">
        <div class="admin-shell">
          <div class="admin-error">{error}</div>
        </div>
      </div>
    );
  }

  const url = newToken ? `${window.location.origin}/register/${newToken.token}` : null;

  return (
    <div class="admin-page">
      <div class="admin-shell">
        <div class="page-head">
          <div class="l">
            <div class="eyebrow">Admin · Invites</div>
            <h1>
              Send the <i>key</i>.
            </h1>
            <p>Generate a single-use invite link for the next person on your team.</p>
          </div>
          <div class="r">
            <b>{invites?.length ?? '—'}</b>
            {(invites?.length ?? 0) === 1 ? 'outstanding' : 'outstanding'}
          </div>
        </div>

        {newToken && (
          <div class="token-banner" role="status">
            <div class="token-banner-body">
              <div class="token-banner-eyebrow">New invite</div>
              <div class="token-banner-url" data-testid="token-url">{url}</div>
              <div class="token-banner-sub">
                Share this link. It can be used <b>once</b> and expires{' '}
                {new Date(newToken.expiresAt.replace(' ', 'T') + 'Z').toLocaleDateString()}.
                The URL is shown above only — the token is gone after you dismiss this.
              </div>
            </div>
            <div class="token-banner-actions">
              <button
                type="button"
                class="doc-action primary"
                data-testid="copy-token"
                onClick={() => copyToken(newToken.token)}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                class="doc-action"
                onClick={dismissBanner}
                data-testid="dismiss-token"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <form class="invite-form" onSubmit={onCreate}>
          <label class="invite-form-label">
            <span class="vis-bar-eyebrow">Expires in</span>
            <select
              class="invite-select"
              value={expiryDays}
              onChange={(e) =>
                setExpiryDays(parseInt((e.target as HTMLSelectElement).value, 10))
              }
              disabled={creating}
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
          <button type="submit" class="doc-action primary" disabled={creating}>
            {creating ? 'Creating…' : 'New invite'}
          </button>
        </form>

        {error && <div class="admin-error inline">{error}</div>}

        <div class="section">
          <h3>
            Outstanding invites <span class="count">{invites?.length ?? 0}</span>
          </h3>
          {invites === null ? (
            <div class="documents-empty">Loading invites…</div>
          ) : invites.length === 0 ? (
            <div class="documents-empty">No outstanding invites. Create one above.</div>
          ) : (
            <div class="users-table-wrap">
              <table class="users-table">
                <thead>
                  <tr>
                    <th>Created</th>
                    <th>Expires</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv) => (
                    <tr key={inv.id}>
                      <td class="users-table-sub">{fmtAbsolute(inv.createdAt)}</td>
                      <td class="users-table-sub">{fmtAbsolute(inv.expiresAt)}</td>
                      <td>
                        <button
                          type="button"
                          class="doc-action danger"
                          disabled={revokingId === inv.id}
                          onClick={() => onRevoke(inv.id)}
                          data-testid={`revoke-${inv.id}`}
                        >
                          {revokingId === inv.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// SQLite "YYYY-MM-DD HH:MM:SS" timestamps rendered to a short,
// human label. Differs from DocumentsList.fmtRelative — invites
// are short-lived (days, not weeks), so an absolute timestamp
// reads cleaner than "5h ago" / "3d ago" mutations.
function fmtAbsolute(s: string): string {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return s;
  const y = +m[1]!;
  const mo = +m[2]!;
  const d = +m[3]!;
  const h = +m[4]!;
  const mi = +m[5]!;
  const then = Date.UTC(y, mo - 1, d, h, mi);
  const diffMs = then - Date.now();
  const day = Math.round(diffMs / (24 * 3600 * 1000));
  const time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  if (Math.abs(day) < 1) return `today · ${time}`;
  if (day === 1) return `tomorrow · ${time}`;
  if (day === -1) return `yesterday · ${time}`;
  return `${y}-${m[2]}-${m[3]} · ${time}`;
}
