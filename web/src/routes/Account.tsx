import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { useAuth } from '../hooks/useAuth';

// Account — /account. Three sections: success banner (?linked=ok),
// Profile (read-only username + role), Linked accounts (Password +
// SSO status, link/unlink inline forms).
//
// p7-T06 — link flow: password confirm → /api/account/link/sso/start
// returns { location }, then full-page nav via window.location.assign
// to the IdP. Unlink flow: password confirm → /unlink → refresh
// useAuth + flip local status state in-place (no full-page reload).
// Forms only render when meaningful — password-only user without SSO
// sees "Link", user with both sees "Unlink", OIDC-only user sees
// neither (server enforces the sentinel-only invariant).

interface LinkStatus {
  password: { set: boolean };
  oidc: { linked: boolean; issuer?: string; linkedAt?: string };
}

export function Account() {
  const { user, refresh } = useAuth();
  const [location] = useLocation();
  const query = new URLSearchParams(location.split('?')[1] ?? '');
  const showLinked = query.get('linked') === 'ok';

  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [showUnlinkForm, setShowUnlinkForm] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/account/link/status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!cancelled) setStatus(s as LinkStatus | null);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function cancelForms() {
    setShowLinkForm(false);
    setShowUnlinkForm(false);
    setPassword('');
    setError(null);
  }

  async function onLinkSubmit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/link/sso/start', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(j?.error ?? 'Failed to start link');
        return;
      }
      const { location: idpLocation } = (await res.json()) as { location: string };
      // ponytail: full-page nav, not wouter navigate — the IdP is a
      // separate origin so SPA routing would just bounce.
      window.location.assign(idpLocation);
    } finally {
      setBusy(false);
    }
  }

  async function onUnlinkSubmit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/link/sso/unlink', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(j?.error ?? 'Failed to unlink');
        return;
      }
      await refresh();
      setStatus((s) => (s ? { ...s, oidc: { linked: false } } : s));
      cancelForms();
    } finally {
      setBusy(false);
    }
  }

  // RouteGuard guarantees authentication + redirect; the null check is
  // belt-and-braces in case the guard hasn't rendered yet.
  if (!user) return null;
  if (!status) return <div class="route-loading">Loading…</div>;

  // The "can" flags capture the conditions that turn the link/unlink
  // buttons on. Password-only users without SSO see "Link"; users with
  // both methods see "Unlink"; OIDC-only users see neither (server
  // already 400s those requests).
  const canLink = !status.oidc.linked && status.password.set;
  const canUnlink = status.oidc.linked && status.password.set;

  return (
    <div class="account-page">
      <div class="account-shell">
        <div class="page-head">
          <div class="l">
            <div class="eyebrow">Account</div>
            <h1>
              Your <i>account</i>.
            </h1>
            <p>Profile and sign-in methods.</p>
          </div>
        </div>

        {showLinked && <div class="account-banner">Single sign-on linked.</div>}

        <section class="account-panel">
          <h2>Profile</h2>
          <dl class="account-dl">
            <dt>Username</dt>
            <dd>{user.username}</dd>
            <dt>Role</dt>
            <dd>
              <span class={`role-badge role-${user.role}`}>{user.role}</span>
            </dd>
          </dl>
        </section>

        <section class="account-panel">
          <h2>Linked accounts</h2>
          <ul class="account-list">
            <li>
              <strong>Password:</strong>{' '}
              {status.password.set ? '✓ set' : '✗ not set'}
            </li>
            <li>
              <strong>Single sign-on:</strong>{' '}
              {status.oidc.linked
                ? `✓ linked to ${status.oidc.issuer ?? 'identity provider'}`
                : '✗ not linked'}
            </li>
          </ul>

          {error && <div class="account-error">{error}</div>}

          {canLink &&
            (showLinkForm ? (
              <form class="account-form" onSubmit={onLinkSubmit}>
                <label>
                  Confirm your password to link single sign-on
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onInput={(e) =>
                      setPassword((e.currentTarget as HTMLInputElement).value)
                    }
                  />
                </label>
                <div class="account-actions">
                  <button type="submit" class="doc-action primary" disabled={busy}>
                    {busy ? 'Continuing…' : 'Continue to single sign-on'}
                  </button>
                  <button type="button" class="doc-action" onClick={cancelForms}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                class="doc-action primary"
                onClick={() => {
                  setShowLinkForm(true);
                  setError(null);
                }}
              >
                Link single sign-on
              </button>
            ))}

          {canUnlink &&
            (showUnlinkForm ? (
              <form class="account-form" onSubmit={onUnlinkSubmit}>
                <label>
                  Confirm your password to unlink single sign-on
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onInput={(e) =>
                      setPassword((e.currentTarget as HTMLInputElement).value)
                    }
                  />
                </label>
                <div class="account-actions">
                  <button type="submit" class="doc-action danger" disabled={busy}>
                    {busy ? 'Unlinking…' : 'Unlink single sign-on'}
                  </button>
                  <button type="button" class="doc-action" onClick={cancelForms}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                class="doc-action danger"
                onClick={() => {
                  setShowUnlinkForm(true);
                  setError(null);
                }}
              >
                Unlink single sign-on
              </button>
            ))}
        </section>
      </div>
    </div>
  );
}