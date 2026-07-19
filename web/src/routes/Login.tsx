import { useEffect, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { fetchAuthStatus, login, type AuthStatusOidc } from '../services/auth';
import { useAuth } from '../hooks/useAuth';

// Login — username/password form. On success, navigates to ?next
// (default /chat). A "Create the first account" link is shown only
// when /api/auth/status reports firstUserAvailable.
//
// p6-T09 — also renders a "Sign in with <Provider>" button below
// the password form when /status reports `oidc.enabled`. The button
// is a full-nav anchor to /api/auth/oidc/login?next=<current next>;
// the server handles PKCE + state cookie + 302 to the IdP. A
// callback error (?oidc_error=<code>) renders an inline auth-error
// above the password form.

const OIDC_ERROR_MESSAGES: Record<string, string> = {
  // ponytail: each code has a different remediation so the user knows
  // what to do (retry vs ask admin). Generic message for any unknown
  // code so a future server change doesn't surface raw 'undefined'.
  state: 'Sign-in session expired. Please try again.',
  exchange: 'Could not reach the identity provider. Please try again in a moment.',
  token: 'Sign-in failed. Please try again.',
  denied: 'Your account is not permitted to access DocKhoj. Contact your administrator.',
  config: 'Single sign-on is misconfigured. Contact your administrator.',
  // p7-T06 — link-mode callback errors (api-auth.ts: /callback when
  // state.mode === 'link'). link_session fires when the original
  // session expired before the user came back from the IdP.
  link_session: 'Your session expired before the link completed. Sign in again and try again.',
  link_already: 'Single sign-on is already linked to your account.',
  link_conflict: 'That identity is already linked to another account. Contact your administrator.',
};

function oidcErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return OIDC_ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.';
}

export function Login() {
  const { refresh } = useAuth();
  const [location, navigate] = useLocation();
  const query = new URLSearchParams(location.split('?')[1] ?? '');
  const next = query.get('next') ?? '/chat';
  const oidcErrorFromUrl = oidcErrorMessage(query.get('oidc_error'));

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(oidcErrorFromUrl);
  const [firstUserAvailable, setFirstUserAvailable] = useState<boolean | null>(null);
  const [oidc, setOidc] = useState<AuthStatusOidc | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAuthStatus()
      .then((s) => {
        if (cancelled) return;
        setFirstUserAvailable(s.firstUserAvailable);
        // ponytail: the server is the source of truth on whether OIDC is
        // configured. Treat a missing `oidc` field (older server) as
        // disabled — the type makes it optional exactly so this can be
        // a graceful no-op rather than a hard requirement.
        setOidc(s.oidc ?? { enabled: false, providerName: '' });
      })
      .catch(() => {
        if (cancelled) return;
        setFirstUserAvailable(false);
        setOidc({ enabled: false, providerName: '' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(username, password);
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setSubmitting(false);
    }
  }

  // ponytail: OIDC button is an <a>, not a <button>, because it triggers
  // a full-page navigation (server 302 → IdP). Using an <a> preserves
  // middle-click / cmd-click behavior and screen-reader semantics; a
  // <button> would need a manual window.location.assign which loses those.
  const oidcEnabled = oidc?.enabled === true;
  const oidcProvider = oidc?.providerName?.trim() || 'SSO';
  const oidcLoginHref = `/api/auth/oidc/login?next=${encodeURIComponent(next)}`;

  return (
    <div class="auth-page">
      <div class="auth-card">
        <div class="brand">
          <span class="brand-mark" />
          <span class="brand-name">
            DocKhoj<i>.</i>
          </span>
        </div>

        <h1>Sign in</h1>

        {error && <div class="auth-error">{error}</div>}

        {oidcEnabled && (
          <>
            <a class="auth-sso" href={oidcLoginHref}>
              <span class="auth-sso-mark" aria-hidden="true" />
              <span class="auth-sso-label">Sign in with {oidcProvider}</span>
            </a>
            <div class="auth-or" aria-hidden="true">
              <span class="auth-or-line" />
              <span class="auth-or-text">or</span>
              <span class="auth-or-line" />
            </div>
          </>
        )}

        <form onSubmit={onSubmit}>
          <label>
            Username
            <input
              type="text"
              autoComplete="username"
              required
              value={username}
              onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
          </label>
          <button type="submit" class="auth-submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div class="auth-foot">
          {firstUserAvailable === true ? (
            <Link href="/register">Create the first account</Link>
          ) : firstUserAvailable === false ? (
            <span class="muted">Registration requires an invite</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
