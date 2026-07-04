import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { useAuth } from '../hooks/useAuth';

// RouteGuard — wraps an auth-required page. Behaviour:
//   loading      → brief "Loading…" placeholder (avoids a flash of
//                  the login redirect before /api/auth/me resolves).
//   anonymous    → navigate to /login?next=<original path>.
//   authenticated + requireRole='admin' + not admin → render a 403
//                  view (don't silently redirect — the user should
//                  see they were denied, not bounced to /login).
//   authenticated + (no role, or matching role) → render children.
//
// The redirect runs once per "anonymous" transition. We capture the
// path at the moment we redirect (not on every effect run) — a
// naive `useEffect([status, location])` re-fires after the navigate
// and captures the new path ("/login?next=..."), producing an
// infinite redirect loop.

interface Props {
  children: ComponentChildren;
  requireRole?: 'admin';
}

export function RouteGuard({ children, requireRole }: Props) {
  const { user, status } = useAuth();
  const [location, navigate] = useLocation();
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (status === 'anonymous' && !redirectedRef.current) {
      redirectedRef.current = true;
      const next = encodeURIComponent(location);
      navigate(`/login?next=${next}`, { replace: true });
    }
    if (status === 'authenticated') {
      // Reset the latch so a logout-then-login cycle can redirect
      // again from the new page.
      redirectedRef.current = false;
    }
  }, [status, location, navigate]);

  if (status === 'loading') {
    return <div class="route-loading">Loading…</div>;
  }

  if (status === 'anonymous') {
    // The effect above will navigate; render nothing in the meantime
    // (returning a placeholder here would flash on the screen
    // before the redirect happens).
    return null;
  }

  if (requireRole === 'admin' && user?.role !== 'admin') {
    return (
      <div class="route-denied">
        <h1>403 — Forbidden</h1>
        <p>You don't have permission to view this page.</p>
      </div>
    );
  }

  return <>{children}</>;
}