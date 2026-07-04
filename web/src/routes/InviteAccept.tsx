import { useState } from 'preact/hooks';
import { Link, useLocation, useRoute } from 'wouter-preact';
import { acceptInvite } from '../services/auth';
import { useAuth } from '../hooks/useAuth';

// InviteAccept — /register/:token. Validates a single-use invite
// token + username + password. On success, logs in and redirects to
// /chat. On 410 (expired / used), shows an error and a back link.

export function InviteAccept() {
  const { refresh } = useAuth();
  const [, navigate] = useLocation();
  // useRoute is the wouter-preact equivalent of useParams(). We
  // index into the matched params rather than relying on a typed
  // signature — wouter's DefaultParams constraint would force a
  // `[key: string]` index signature we don't want to maintain.
  const match = useRoute('/register/:token');
  const token = (match[1] as { token?: string } | null)?.token ?? '';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (!token) {
      setError('Missing invite token');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await acceptInvite({ token, username, password });
      await refresh();
      navigate('/chat', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite failed');
      setSubmitting(false);
    }
  }

  return (
    <div class="auth-page">
      <div class="auth-card">
        <div class="brand">
          <span class="brand-mark" />
          <span class="brand-name">DocKhoj<i>.</i></span>
        </div>
        <div class="auth-eyebrow">You've been invited</div>
        <h1>Accept invite</h1>
        <p class="auth-sub">Pick a username and password to finish creating your account.</p>

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
          <button type="submit" class="auth-submit" disabled={submitting || !token}>
            {submitting ? 'Joining…' : 'Join'}
          </button>
        </form>

        <div class="auth-foot">
          <Link href="/login">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}