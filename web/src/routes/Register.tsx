import { useEffect, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { fetchAuthStatus, register } from '../services/auth';
import { useAuth } from '../hooks/useAuth';

// Register — first-user signup. On a server where users already
// exist, the page hides the form and explains invites are required.
// The server enforces the same rule (/api/auth/register returns 403
// when users exist); the SPA just pre-checks via /api/auth/status
// so the page doesn't show a form that will fail on submit.

export function Register() {
  const { refresh } = useAuth();
  const [, navigate] = useLocation();

  const [firstUserAvailable, setFirstUserAvailable] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await register(username, password);
      await refresh();
      navigate('/chat', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
      setSubmitting(false);
    }
  }

  if (firstUserAvailable === null) {
    return <div class="auth-page"><div class="auth-card">Loading…</div></div>;
  }

  if (firstUserAvailable === false) {
    return (
      <div class="auth-page">
        <div class="auth-card">
          <div class="brand">
            <span class="brand-mark" />
            <span class="brand-name">DocKhoj<i>.</i></span>
          </div>
          <h1>Invite only</h1>
          <p>Registration is invite-only. Ask an admin for an invite link.</p>
          <div class="auth-foot">
            <Link href="/login">Back to sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="auth-page">
      <div class="auth-card">
        <div class="brand">
          <span class="brand-mark" />
          <span class="brand-name">DocKhoj<i>.</i></span>
        </div>
        <div class="auth-eyebrow">First account</div>
        <h1>Create your account</h1>
        <p class="auth-sub">
          The first account on this DocKhoj instance is the admin. You can
          invite teammates afterwards.
        </p>

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
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
            <span class="auth-hint">At least 12 characters, including one symbol.</span>
          </label>
          {error && <div class="auth-error">{error}</div>}
          <button type="submit" class="auth-submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <div class="auth-foot">
          <Link href="/login">Already have an account? Sign in</Link>
        </div>
      </div>
    </div>
  );
}