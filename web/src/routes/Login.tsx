import { useEffect, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { fetchAuthStatus, login } from '../services/auth';
import { useAuth } from '../hooks/useAuth';

// Login — username/password form. On success, navigates to ?next
// (default /chat). A "Create the first account" link is shown only
// when /api/auth/status reports firstUserAvailable.

export function Login() {
  const { refresh } = useAuth();
  const [location, navigate] = useLocation();
  const next = new URLSearchParams(location.split('?')[1] ?? '').get('next') ?? '/chat';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [firstUserAvailable, setFirstUserAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAuthStatus()
      .then((s) => {
        if (!cancelled) setFirstUserAvailable(s.firstUserAvailable);
      })
      .catch(() => {
        if (!cancelled) setFirstUserAvailable(false);
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
          {error && <div class="auth-error">{error}</div>}
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