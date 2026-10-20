import type { ReactNode } from 'react';
import { env } from '../../config/env';
import { useAuthStore } from '../../state/authStore';
import { Toasts } from './Toasts';
import { Spinner } from './primitives';
import { AuthScreen } from '../screens/AuthScreen';

/**
 * Optional beta gate (`VITE_REQUIRE_LOGIN=true`): until an access code has been used on this device, only the sign-in
 * screen is shown. The session is kept by the browser, so a signed-in device opens straight into the app, also offline.
 * Does nothing without a backend or without the flag.
 */
export function RequireLogin({ children, enabled = env.requireLogin }: { children: ReactNode; enabled?: boolean }) {
  const status = useAuthStore((s) => s.status);
  if (!enabled || status === 'disabled' || status === 'signedIn') return <>{children}</>;
  if (status === 'loading') {
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }} role="status" aria-label="Loading">
        <Spinner />
      </div>
    );
  }
  return (
    <>
      <AuthScreen />
      <Toasts />
    </>
  );
}
