import { useEffect, useRef, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { useAuth } from '../hooks/useAuth';
import { logout } from '../services/auth';

// UserMenu — username chip on the right side of the TopBar. Click
// reveals a dropdown with Logout (always) and Admin → Users / Admin
// → Invites (admin only). Logout calls POST /api/auth/logout (which
// clears the `dockhoj_sid` cookie via `credentials: 'include'`),
// then `refresh()` flips auth state, then we navigate to /login.
//
// The component returns null when there's no user — the TopBar
// hides the chip during the loading/anonymous window so it doesn't
// flicker before RouteGuard redirects the user to /login.
//
// Dropdown close behavior mirrors the chat toolbar's mode popover
// (routes/Chat.tsx): outside mousedown and Escape both close it.
//
// ponytail: native `<button>` + `<a>` + a 10-line effect — no
// popover library.

export function UserMenu() {
  const { user, refresh } = useAuth();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  const isAdmin = user.role === 'admin';

  async function onLogout() {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
    } catch {
      // Server failed to clear the cookie; still flip local state
      // and bounce to /login so the user isn't stuck on a stale UI.
    } finally {
      await refresh();
      setBusy(false);
      setOpen(false);
      navigate('/login');
    }
  }

  return (
    <div class="user-menu" ref={ref}>
      <button
        type="button"
        class="user-menu-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${user.username}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span class="user-menu-name">{user.username}</span>
        <span class="user-menu-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div class="user-menu-pop" role="menu">
          {isAdmin && (
            <>
              <Link
                href="/admin/users"
                class="user-menu-item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                Admin → Users
              </Link>
              <Link
                href="/admin/invites"
                class="user-menu-item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                Admin → Invites
              </Link>
            </>
          )}
          <button
            type="button"
            class="user-menu-item user-menu-logout"
            role="menuitem"
            onClick={onLogout}
            disabled={busy}
          >
            {busy ? 'Signing out…' : 'Logout'}
          </button>
        </div>
      )}
    </div>
  );
}