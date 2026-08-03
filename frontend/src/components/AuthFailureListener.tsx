'use client';

/**
 * AuthFailureListener — global reaction to an expired / invalid JWT.
 *
 * api.ts dispatches `geny:auth-failed` (from a REST 401 or a 4401 WS close)
 * after clearing the token. This mounts once at the app root and turns that
 * signal into a re-login flow:
 *
 *   - Desktop connector → drop the keychain token and reload the windows
 *     (refresh shows the login/settings window when there's no token).
 *   - Plain browser → reflect logged-out so the header's login affordance
 *     re-appears (the token is already cleared by api.ts).
 *
 * Without this, an expired token just rendered empty data ("VTuber 세션이
 * 없습니다") with no way back in.
 */

import { useEffect } from 'react';
import { useAuthStore } from '@/store/useAuthStore';
import { setToken } from '@/lib/authApi';

const TOKEN_KEY = 'geny_auth_token';

export default function AuthFailureListener() {
  useEffect(() => {
    let handling = false; // de-dupe a burst of 401s into one re-login
    const onAuthFailed = async () => {
      if (handling) return;
      handling = true;
      const conn = window.connector;
      if (conn?.secureStore && conn?.windowControl) {
        // The 401 may have come from a request armed with an OLDER token
        // (boot-time race, stale singleton) — api.ts already cleared
        // localStorage before dispatching. Before logging the user out,
        // check whether the CONNECTOR KEYCHAIN token is still alive; if so,
        // re-adopt it and heal in place. Wiping the keychain on a false
        // alarm turned one stray 401 into a full logout loop.
        try {
          const kc = await conn.secureStore.get(TOKEN_KEY);
          if (kc) {
            const r = await fetch('/api/auth/status', { headers: { Authorization: `Bearer ${kc}` } });
            const j = await r.json().catch(() => null);
            if (j?.is_authenticated) {
              setToken(kc);
              handling = false;
              return; // keychain token is valid — stale failure, stay logged in
            }
          }
        } catch {
          /* verification unreachable — fall through to the logout path */
        }
        // Keychain token truly dead: clear it, then reload — refreshAll()
        // shows the settings/login window when no token is present.
        conn.secureStore
          .delete(TOKEN_KEY)
          .catch(() => undefined)
          .finally(() => {
            try {
              conn.windowControl.openSettings();
              conn.windowControl.refresh();
            } catch {
              /* bridge gone — nothing more we can do */
            }
            handling = false;
          });
      } else {
        // Browser: token already removed by api.ts; flip the store so the
        // header/login UI reflects the logged-out state.
        useAuthStore.setState({ isAuthenticated: false });
        handling = false;
      }
    };
    window.addEventListener('geny:auth-failed', onAuthFailed);
    return () => window.removeEventListener('geny:auth-failed', onAuthFailed);
  }, []);
  return null;
}
