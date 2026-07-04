import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { fetchMe, type AuthUser } from '../services/auth';

// p4-T16 — useAuth hook + AuthProvider. The provider is mounted at
// the App root so every page reads the same auth state. On mount it
// calls /api/auth/me; on 401 the status flips to 'anonymous' (the
// SPA redirects the user to /login via the RouteGuard).
//
// ponytail: a 30-line context + a fetch call is the right size for
// this. A state-management library would be heavier than the problem.

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthState {
  user: AuthUser | null;
  status: AuthStatus;
  // Force a re-check after login/logout so context consumers
  // re-render without waiting for a navigation.
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState>({
  user: null,
  status: 'loading',
  refresh: async () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthCtx);
}

export function AuthProvider({ children }: { children: ComponentChildren }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  async function refresh() {
    setStatus('loading');
    try {
      const me = await fetchMe();
      if (me) {
        setUser(me);
        setStatus('authenticated');
      } else {
        setUser(null);
        setStatus('anonymous');
      }
    } catch {
      // Network / server error — treat as anonymous so the user
      // can still see the login page (and isn't stuck on a
      // spinner).
      setUser(null);
      setStatus('anonymous');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <AuthCtx.Provider value={{ user, status, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}